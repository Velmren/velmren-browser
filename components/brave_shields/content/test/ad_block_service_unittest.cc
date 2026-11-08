// Copyright (c) 2026 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/components/brave_shields/content/browser/ad_block_service.h"

#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/json/values_util.h"
#include "base/location.h"
#include "base/memory/scoped_refptr.h"
#include "base/run_loop.h"
#include "base/test/bind.h"
#include "base/test/run_until.h"
#include "base/test/scoped_feature_list.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "brave/components/brave_shields/content/browser/ad_block_custom_filters_provider.h"
#include "brave/components/brave_shields/content/browser/ad_block_engine.h"
#include "brave/components/brave_shields/content/browser/ad_block_engine_wrapper.h"
#include "brave/components/brave_shields/content/browser/ad_block_subscription_download_manager.h"
#include "brave/components/brave_shields/content/browser/ad_block_subscription_service_manager.h"
#include "brave/components/brave_shields/content/test/ad_block_unit_test_helper.h"
#include "brave/components/brave_shields/content/test/test_filters_provider.h"
#include "brave/components/brave_shields/core/browser/ad_block_custom_resource_provider.h"
#include "brave/components/brave_shields/core/browser/ad_block_dat_cache_manager.h"
#include "brave/components/brave_shields/core/browser/ad_block_default_resource_provider.h"
#include "brave/components/brave_shields/core/browser/ad_block_filters_provider.h"
#include "brave/components/brave_shields/core/browser/ad_block_filters_provider_manager.h"
#include "brave/components/brave_shields/core/browser/ad_block_resource_provider.h"
#include "brave/components/brave_shields/core/common/adblock/rs/src/lib.rs.h"
#include "brave/components/brave_shields/core/common/features.h"
#include "brave/components/brave_shields/core/common/pref_names.h"
#include "brave/components/velmren/public_filters.h"
#include "components/keyed_service/core/keyed_service.h"
#include "components/prefs/scoped_user_pref_update.h"
#include "components/prefs/testing_pref_service.h"
#include "net/base/filename_util.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/blink/public/mojom/loader/resource_load_info.mojom-shared.h"
#include "url/gurl.h"

namespace brave_shields {

namespace {

enum class EngineType {
  kDefault,
  kAdditional,
};

constexpr std::string_view kAdGuardAnnoyancesUrl =
    "https://filters.adtidy.org/extension/ublock/filters/21.txt";

class DelayedFiltersProvider : public AdBlockFiltersProvider {
 public:
  using FilterSetLoader =
      base::OnceCallback<void(rust::Box<adblock::FilterSet>*)>;
  using LoadCallback = base::OnceCallback<void(FilterSetLoader)>;

  explicit DelayedFiltersProvider(AdBlockFiltersProviderManager* manager)
      : AdBlockFiltersProvider(false, manager) {}

  void SetRules(std::string rules) {
    rules_ = std::move(rules);
    NotifyObservers(false);
  }

  void LoadFilterSet(LoadCallback callback) override {
    pending_loads_.push_back(
        {std::move(callback), {rules_.begin(), rules_.end()}});
  }

  std::string GetNameForDebugging() override {
    return "DelayedFiltersProvider";
  }

  size_t load_count() const { return pending_loads_.size(); }

  void CompleteLoad(size_t index, base::OnceClosure on_parsed = {}) {
    auto& load = pending_loads_.at(index);
    std::move(load.callback)
        .Run(base::BindOnce(
            [](std::vector<unsigned char> rules, base::OnceClosure on_parsed,
               rust::Box<adblock::FilterSet>* filter_set) {
              (*filter_set)->add_filter_list_with_permissions(rules, 0);
              if (on_parsed) {
                std::move(on_parsed).Run();
              }
            },
            std::move(load.rules), std::move(on_parsed)));
  }

 private:
  struct PendingLoad {
    LoadCallback callback;
    std::vector<unsigned char> rules;
  };

  std::string rules_;
  std::vector<PendingLoad> pending_loads_;
};

// Runs ShouldStartRequest on the adblock task runner and returns the result.
adblock::BlockerResult ShouldStartRequest(AdBlockService* service,
                                          EngineType engine_type,
                                          std::string_view url) {
  adblock::BlockerResult out;
  base::RunLoop run_loop;
  service->AsyncCall(
      base::BindLambdaForTesting([&](AdBlockEngineWrapper* wrapper) {
        AdBlockEngine& block_engine =
            engine_type == EngineType::kDefault
                ? wrapper->default_engine_for_testing()
                : wrapper->additional_filters_engine_for_testing();
        out = block_engine.ShouldStartRequest(
            GURL(url), blink::mojom::ResourceType::kScript,
            url::Origin::Create(GURL("https://test.com")), "GET", false, false,
            false);
        run_loop.Quit();
      }));
  run_loop.Run();
  return out;
}

}  // namespace

class FilterListObserver : public AdBlockService::Observer {
 public:
  using Callback = base::RepeatingCallback<void(bool, bool)>;
  explicit FilterListObserver(Callback cb) : cb_(std::move(cb)) {}
  ~FilterListObserver() override = default;
  void OnFilterListLoaded(
      bool is_default_engine,
      AdBlockService::FilterListLoadResult result) override {
    cb_.Run(is_default_engine,
            result == AdBlockService::FilterListLoadResult::kLoaded);
  }

 private:
  Callback cb_;
};

// TODO need a test that dat gets rebuilt if only one filter list is newer
class DATLoadObserver : public AdBlockService::Observer {
 public:
  DATLoadObserver() = default;
  ~DATLoadObserver() override = default;

  void OnDATLoaded(bool is_default_engine, bool success) override {
    if (is_default_engine) {
      default_loaded_ = true;
      default_success_ = success;
    } else {
      additional_loaded_ = true;
      additional_success_ = success;
    }
  }

  bool BothLoaded() const { return default_loaded_ && additional_loaded_; }
  bool default_success() const { return default_success_; }
  bool additional_success() const { return additional_success_; }

 private:
  bool default_loaded_ = false;
  bool default_success_ = false;
  bool additional_loaded_ = false;
  bool additional_success_ = false;
};

class AdBlockServiceTestBase : public testing::Test {
 public:
  AdBlockServiceTestBase()
      : resource_storage_(adblock::new_empty_resource_storage()) {}

  void SetUp() override {
    RegisterPrefsForAdBlockService(prefs_.registry());
    // These cache tests install their own filter providers and use no download
    // service. Keep the product's first-run subscriptions out of this fixture.
    prefs_.SetBoolean(prefs::kAdBlockPublicListsSeeded, true);
    prefs_.SetInteger(prefs::kAdBlockPublicListsSeededVersion,
                      velmren::kPublicFilterCatalogVersion);
    ASSERT_TRUE(temp_dir_.CreateUniqueTempDir());
    ASSERT_TRUE(profile_dir_.CreateUniqueTempDir());
  }

 protected:
  DATFileDataBuffer CreateAdblockDAT(std::string_view filters) {
    std::vector<unsigned char> buffer(filters.begin(), filters.end());
    AdBlockEngine engine(true);
    engine.Load(false, buffer, *resource_storage_);
    return engine.Serialize();
  }

  void CreateCachedDATFiles(std::string_view default_rules,
                            std::string_view additional_rules) {
    base::FilePath cache_dir =
        profile_dir_.GetPath().AppendASCII("adblock_cache");
    ASSERT_TRUE(base::CreateDirectory(cache_dir));
    ASSERT_TRUE(base::WriteFile(cache_dir.AppendASCII("engine0.dat"),
                                CreateAdblockDAT(default_rules)));
    ASSERT_TRUE(base::WriteFile(cache_dir.AppendASCII("engine1.dat"),
                                CreateAdblockDAT(additional_rules)));
  }

  void CreateCachedDefaultDATFile(std::string_view default_rules) {
    base::FilePath cache_dir =
        profile_dir_.GetPath().AppendASCII("adblock_cache");
    ASSERT_TRUE(base::CreateDirectory(cache_dir));
    ASSERT_TRUE(base::WriteFile(cache_dir.AppendASCII("engine0.dat"),
                                CreateAdblockDAT(default_rules)));
  }

  void CreateCachedAdditionalDATFile(std::string_view additional_rules) {
    base::FilePath cache_dir =
        profile_dir_.GetPath().AppendASCII("adblock_cache");
    ASSERT_TRUE(base::CreateDirectory(cache_dir));
    ASSERT_TRUE(base::WriteFile(cache_dir.AppendASCII("engine1.dat"),
                                CreateAdblockDAT(additional_rules)));
  }

  std::unique_ptr<AdBlockService> CreateServiceWithTaskRunner(
      scoped_refptr<base::SequencedTaskRunner> task_runner,
      bool defer_subscriptions = false) {
    download_manager_ = std::make_unique<AdBlockSubscriptionDownloadManager>(
        nullptr, task_runner);
    static_cast<KeyedService*>(download_manager_.get())->Shutdown();
    auto service = std::make_unique<AdBlockService>(
        &prefs_, "en", nullptr, task_runner,
        base::BindOnce(
            [](bool defer_subscriptions,
               base::OnceCallback<void(AdBlockSubscriptionDownloadManager*)>*
                   pending_callback,
               AdBlockSubscriptionDownloadManager* manager,
               base::OnceCallback<void(AdBlockSubscriptionDownloadManager*)>
                   cb) {
              if (defer_subscriptions) {
                *pending_callback = std::move(cb);
              } else {
                std::move(cb).Run(manager);
              }
            },
            defer_subscriptions, &pending_download_manager_,
            download_manager_.get()),
        profile_dir_.GetPath());
    service->custom_resource_provider()->OverrideResourcesForTesting(
        adblock::new_empty_resource_storage());
    SetupAdBlockServiceForTesting(service.get());
    return service;
  }

  void InitializeSubscriptions() {
    std::move(pending_download_manager_).Run(download_manager_.get());
  }

  bool WriteSubscriptionRules(AdBlockService* service,
                              std::string_view url,
                              std::string_view rules) {
    base::FilePath path;
    return net::FileURLToFilePath(
               service->subscription_service_manager()->GetListTextFileUrl(
                   GURL(url)),
               &path) &&
           base::CreateDirectory(path.DirName()) &&
           base::WriteFile(path, rules);
  }

  void SetPersistedSubscription(std::string_view url) {
    base::DictValue info;
    info.Set("enabled", true);
    info.Set("last_update_attempt", base::TimeToValue(base::Time()));
    info.Set("last_successful_update_attempt", base::TimeToValue(base::Time()));
    info.Set("expires", kSubscriptionDefaultExpiresHours);
    ScopedDictPrefUpdate update(&prefs_, prefs::kAdBlockListSubscriptions);
    update->Set(url, std::move(info));
  }

  base::test::ScopedFeatureList feature_list_;
  base::ScopedTempDir temp_dir_;
  TestingPrefServiceSimple prefs_;
  base::ScopedTempDir profile_dir_;
  rust::Box<adblock::BraveCoreResourceStorage> resource_storage_;
  std::unique_ptr<AdBlockSubscriptionDownloadManager> download_manager_;
  base::OnceCallback<void(AdBlockSubscriptionDownloadManager*)>
      pending_download_manager_;
};

class AdBlockServiceTest : public AdBlockServiceTestBase {
 public:
  AdBlockServiceTest() {
    feature_list_.InitAndEnableFeature(features::kAdblockDATCache);
  }

 protected:
  std::unique_ptr<AdBlockService> CreateService() {
    return CreateServiceWithTaskRunner(
        task_environment_.GetMainThreadTaskRunner());
  }

  base::test::TaskEnvironment task_environment_;
};

class AdBlockServiceQueuedTest : public AdBlockServiceTestBase {
 public:
  AdBlockServiceQueuedTest() {
    feature_list_.InitAndEnableFeature(features::kAdblockDATCache);
  }

 protected:
  base::test::TaskEnvironment task_environment_{
      base::test::TaskEnvironment::TimeSource::MOCK_TIME,
      base::test::TaskEnvironment::ThreadPoolExecutionMode::QUEUED};
};

class AdBlockServiceCatalogMigrationTest
    : public AdBlockServiceTest,
      public testing::WithParamInterface<bool> {};

TEST_P(AdBlockServiceCatalogMigrationTest,
       LegacyCachedEngineRebuildsOfflineAndThenUsesNewCache) {
  prefs_.ClearPref(prefs::kAdBlockPublicListsSeededVersion);
  CreateCachedDATFiles("||default-cache.com^\n",
                       "||old-additional-cache.com^\n");
  auto service = CreateServiceWithTaskRunner(
      task_environment_.GetMainThreadTaskRunner(), true);
  ASSERT_TRUE(WriteSubscriptionRules(service.get(), kAdGuardAnnoyancesUrl,
                                     "||new-annoyances-rule.com^\n"));
  DATLoadObserver dat_observer;
  service->AddObserver(&dat_observer);
  bool additional_filters_loaded = false;
  FilterListObserver filter_observer(
      base::BindLambdaForTesting([&](bool is_default, bool success) {
        if (!is_default && success) {
          additional_filters_loaded = true;
        }
      }));
  service->AddObserver(&filter_observer);

  // Cover migration before cache reads and after the old DAT preload finishes.
  if (GetParam()) {
    ASSERT_TRUE(
        base::test::RunUntil([&]() { return dat_observer.BothLoaded(); }));
    EXPECT_TRUE(dat_observer.additional_success());
    EXPECT_TRUE(ShouldStartRequest(service.get(), EngineType::kAdditional,
                                   "https://old-additional-cache.com/a.js")
                    .matched);
  }
  InitializeSubscriptions();

  ASSERT_TRUE(base::test::RunUntil([&]() {
    return dat_observer.BothLoaded() && additional_filters_loaded &&
           !prefs_.GetBoolean(prefs::kAdBlockPublicListsAdditionalCacheDirty);
  }));
  EXPECT_TRUE(dat_observer.default_success());
  EXPECT_EQ(dat_observer.additional_success(), GetParam());
  EXPECT_TRUE(ShouldStartRequest(service.get(), EngineType::kDefault,
                                 "https://default-cache.com/a.js")
                  .matched);
  EXPECT_TRUE(ShouldStartRequest(service.get(), EngineType::kAdditional,
                                 "https://new-annoyances-rule.com/a.js")
                  .matched);
  EXPECT_FALSE(ShouldStartRequest(service.get(), EngineType::kAdditional,
                                  "https://old-additional-cache.com/a.js")
                   .matched);
  EXPECT_EQ(prefs_.GetInteger(prefs::kAdBlockPublicListsSeededVersion),
            velmren::kPublicFilterCatalogVersion);
  service->RemoveObserver(&dat_observer);
  service->RemoveObserver(&filter_observer);
  service.reset();

  auto restarted_service = CreateService();
  DATLoadObserver restarted_observer;
  restarted_service->AddObserver(&restarted_observer);
  ASSERT_TRUE(
      base::test::RunUntil([&]() { return restarted_observer.BothLoaded(); }));
  EXPECT_TRUE(restarted_observer.default_success());
  EXPECT_TRUE(restarted_observer.additional_success());
  EXPECT_TRUE(ShouldStartRequest(restarted_service.get(),
                                 EngineType::kAdditional,
                                 "https://new-annoyances-rule.com/a.js")
                  .matched);
}

INSTANTIATE_TEST_SUITE_P(InitializationOrder,
                         AdBlockServiceCatalogMigrationTest,
                         testing::Bool());

TEST_F(AdBlockServiceTest, InterruptedCatalogCacheRebuildRetriesOnRestart) {
  prefs_.SetBoolean(prefs::kAdBlockPublicListsAdditionalCacheDirty, true);
  SetPersistedSubscription(kAdGuardAnnoyancesUrl);
  CreateCachedDATFiles("||default-cache.com^\n",
                       "||old-additional-cache.com^\n");
  auto service = CreateServiceWithTaskRunner(
      task_environment_.GetMainThreadTaskRunner(), true);
  ASSERT_TRUE(WriteSubscriptionRules(service.get(), kAdGuardAnnoyancesUrl,
                                     "||new-annoyances-rule.com^\n"));
  DATLoadObserver dat_observer;
  service->AddObserver(&dat_observer);
  bool startup_additional_loaded = false;
  FilterListObserver filter_observer(
      base::BindLambdaForTesting([&](bool is_default, bool success) {
        if (!is_default && success) {
          startup_additional_loaded = true;
        }
      }));
  service->AddObserver(&filter_observer);
  ASSERT_TRUE(base::test::RunUntil([&]() {
    return dat_observer.BothLoaded() && startup_additional_loaded;
  }));
  base::test::TestFuture<std::optional<DATFileDataBuffer>,
                         std::optional<DATFileDataBuffer>>
      startup_cache_written;
  service->GetDATCacheManagerForTesting()->MaybeReadCachedDATFiles(
      startup_cache_written.GetCallback());
  ASSERT_TRUE(startup_cache_written.Wait());
  EXPECT_FALSE(service->subscription_service_manager()->is_initialized());
  EXPECT_TRUE(
      prefs_.GetBoolean(prefs::kAdBlockPublicListsAdditionalCacheDirty));
  InitializeSubscriptions();

  ASSERT_TRUE(base::test::RunUntil([&]() {
    return dat_observer.BothLoaded() &&
           !prefs_.GetBoolean(prefs::kAdBlockPublicListsAdditionalCacheDirty);
  }));
  EXPECT_TRUE(dat_observer.default_success());
  EXPECT_FALSE(dat_observer.additional_success());
  EXPECT_TRUE(ShouldStartRequest(service.get(), EngineType::kAdditional,
                                 "https://new-annoyances-rule.com/a.js")
                  .matched);
  EXPECT_FALSE(ShouldStartRequest(service.get(), EngineType::kAdditional,
                                  "https://old-additional-cache.com/a.js")
                   .matched);
  service->RemoveObserver(&dat_observer);
  service->RemoveObserver(&filter_observer);
  service.reset();

  auto restarted_service = CreateService();
  DATLoadObserver restarted_observer;
  restarted_service->AddObserver(&restarted_observer);
  ASSERT_TRUE(
      base::test::RunUntil([&]() { return restarted_observer.BothLoaded(); }));
  EXPECT_TRUE(restarted_observer.default_success());
  EXPECT_TRUE(restarted_observer.additional_success());
  EXPECT_TRUE(ShouldStartRequest(restarted_service.get(),
                                 EngineType::kAdditional,
                                 "https://new-annoyances-rule.com/a.js")
                  .matched);
}

TEST_F(AdBlockServiceTest, LatestProviderSnapshotWinsAndIsCached) {
  CreateCachedDATFiles("||default-cache.com^\n", "||old-cache.com^\n");
  auto service = CreateService();
  DATLoadObserver dat_observer;
  service->AddObserver(&dat_observer);
  ASSERT_TRUE(
      base::test::RunUntil([&]() { return dat_observer.BothLoaded(); }));
  prefs_.SetBoolean(prefs::kAdBlockPublicListsAdditionalCacheDirty, true);
  auto provider = std::make_unique<DelayedFiltersProvider>(
      service->GetFiltersProviderManagerForTesting());
  provider->SetRules("||old-snapshot.com^\n");
  ASSERT_TRUE(
      base::test::RunUntil([&]() { return provider->load_count() == 1; }));

  provider->SetRules("||latest-snapshot.com^\n");
  ASSERT_TRUE(
      base::test::RunUntil([&]() { return provider->load_count() == 2; }));
  auto temporary_provider =
      std::make_unique<TestFiltersProvider>("||removed-provider.com^\n", false);
  temporary_provider->RegisterAsSourceProvider(service.get());
  ASSERT_TRUE(
      base::test::RunUntil([&]() { return provider->load_count() == 3; }));
  // Capture every provider's contribution before removing the temporary one.
  base::test::TestFuture<void> contributions_captured;
  task_environment_.GetMainThreadTaskRunner()->PostTask(
      FROM_HERE, contributions_captured.GetCallback());
  ASSERT_TRUE(contributions_captured.Wait());
  temporary_provider.reset();
  ASSERT_TRUE(
      base::test::RunUntil([&]() { return provider->load_count() == 4; }));

  provider->CompleteLoad(3);
  ASSERT_TRUE(base::test::RunUntil([&]() {
    return !prefs_.GetBoolean(prefs::kAdBlockPublicListsAdditionalCacheDirty);
  }));
  for (size_t index = 0; index < 3; ++index) {
    base::test::TestFuture<void> parsed;
    provider->CompleteLoad(index, parsed.GetCallback());
    ASSERT_TRUE(parsed.Wait());
    // Process the parser reply and its posted resource callback before queries.
    base::test::TestFuture<void> reply_processed;
    task_environment_.GetMainThreadTaskRunner()->PostTask(
        FROM_HERE, reply_processed.GetCallback());
    ASSERT_TRUE(reply_processed.Wait());
    base::test::TestFuture<void> resources_processed;
    task_environment_.GetMainThreadTaskRunner()->PostTask(
        FROM_HERE, resources_processed.GetCallback());
    ASSERT_TRUE(resources_processed.Wait());
  }
  EXPECT_TRUE(ShouldStartRequest(service.get(), EngineType::kAdditional,
                                 "https://latest-snapshot.com/a.js")
                  .matched);
  EXPECT_FALSE(ShouldStartRequest(service.get(), EngineType::kAdditional,
                                  "https://old-snapshot.com/a.js")
                   .matched);
  EXPECT_FALSE(ShouldStartRequest(service.get(), EngineType::kAdditional,
                                  "https://removed-provider.com/a.js")
                   .matched);
  base::test::TestFuture<std::optional<DATFileDataBuffer>,
                         std::optional<DATFileDataBuffer>>
      cache_written;
  service->GetDATCacheManagerForTesting()->MaybeReadCachedDATFiles(
      cache_written.GetCallback());
  ASSERT_TRUE(cache_written.Wait());
  service->RemoveObserver(&dat_observer);
  provider.reset();
  service.reset();

  auto restarted_service = CreateService();
  DATLoadObserver restarted_observer;
  restarted_service->AddObserver(&restarted_observer);
  ASSERT_TRUE(
      base::test::RunUntil([&]() { return restarted_observer.BothLoaded(); }));
  EXPECT_TRUE(restarted_observer.default_success());
  EXPECT_TRUE(restarted_observer.additional_success());
  EXPECT_TRUE(ShouldStartRequest(restarted_service.get(),
                                 EngineType::kAdditional,
                                 "https://latest-snapshot.com/a.js")
                  .matched);
  EXPECT_FALSE(ShouldStartRequest(restarted_service.get(),
                                  EngineType::kAdditional,
                                  "https://old-snapshot.com/a.js")
                   .matched);
  EXPECT_FALSE(ShouldStartRequest(restarted_service.get(),
                                  EngineType::kAdditional,
                                  "https://removed-provider.com/a.js")
                   .matched);
}

TEST_F(AdBlockServiceTest, CatalogCacheWriteFailureKeepsRebuildPending) {
  prefs_.SetBoolean(prefs::kAdBlockPublicListsAdditionalCacheDirty, true);
  SetPersistedSubscription(kAdGuardAnnoyancesUrl);
  ASSERT_TRUE(base::WriteFile(
      profile_dir_.GetPath().AppendASCII("adblock_cache"), "not a directory"));
  auto service = CreateServiceWithTaskRunner(
      task_environment_.GetMainThreadTaskRunner(), true);
  ASSERT_TRUE(WriteSubscriptionRules(service.get(), kAdGuardAnnoyancesUrl,
                                     "||new-annoyances-rule.com^\n"));
  bool additional_filters_loaded = false;
  FilterListObserver observer(
      base::BindLambdaForTesting([&](bool is_default, bool success) {
        if (!is_default && success) {
          additional_filters_loaded = true;
        }
      }));
  service->AddObserver(&observer);
  InitializeSubscriptions();
  ASSERT_TRUE(
      base::test::RunUntil([&]() { return additional_filters_loaded; }));

  // The sequenced probe completes after the engine's preceding cache write.
  base::test::TestFuture<bool> write_result;
  service->GetDATCacheManagerForTesting()->WriteDATFile(
      false, CreateAdblockDAT("||new-annoyances-rule.com^\n"),
      write_result.GetCallback());
  EXPECT_FALSE(write_result.Get());
  EXPECT_TRUE(
      prefs_.GetBoolean(prefs::kAdBlockPublicListsAdditionalCacheDirty));
  EXPECT_TRUE(ShouldStartRequest(service.get(), EngineType::kAdditional,
                                 "https://new-annoyances-rule.com/a.js")
                  .matched);
}

class AdBlockServiceDATCacheDisabledTest : public AdBlockServiceTestBase {
 public:
  AdBlockServiceDATCacheDisabledTest() {
    feature_list_.InitAndDisableFeature(features::kAdblockDATCache);
  }

 protected:
  std::unique_ptr<AdBlockService> CreateService() {
    return CreateServiceWithTaskRunner(
        task_environment_.GetMainThreadTaskRunner());
  }

  base::test::TaskEnvironment task_environment_;
};

TEST_F(AdBlockServiceTest, LoadsCachedDATFilesOnCreation) {
  // Create cached DAT files with known rules
  CreateCachedDATFiles("||blocked-by-default.com^\n",
                       "||blocked-by-additional.com^\n");

  // Create the service - it should load the cached DAT files
  auto service = CreateService();
  DATLoadObserver dat_observer;
  service->AddObserver(&dat_observer);
  bool default_filter_list_loaded = false;
  bool additional_filter_list_loaded = false;
  FilterListObserver filter_list_observer(
      base::BindLambdaForTesting([&](bool is_default, bool success) {
        if (is_default) {
          default_filter_list_loaded = success;
        } else {
          additional_filter_list_loaded = success;
        }
      }));
  service->AddObserver(&filter_list_observer);

  ASSERT_TRUE(
      base::test::RunUntil([&]() { return dat_observer.BothLoaded(); }));

  // Verify default engine rules are loaded (from cached DAT)
  auto result = ShouldStartRequest(service.get(), EngineType::kDefault,
                                   "https://blocked-by-default.com/script.js");
  EXPECT_TRUE(result.matched);

  // Verify additional engine rules are loaded
  result = ShouldStartRequest(service.get(), EngineType::kAdditional,
                              "https://blocked-by-additional.com/script.js");
  EXPECT_TRUE(result.matched);

  // Verify non-blocked URLs are not blocked
  result = ShouldStartRequest(service.get(), EngineType::kDefault,
                              "https://allowed.com/script.js");
  EXPECT_FALSE(result.matched);
}

TEST_F(AdBlockServiceTest, LoadsOnlyDefaultCachedDATFile) {
  // Create a cached DAT file only for the default engine
  CreateCachedDefaultDATFile("||blocked-by-default.com^\n");

  auto service = CreateService();

  DATLoadObserver observer;
  service->AddObserver(&observer);
  ASSERT_TRUE(base::test::RunUntil([&]() { return observer.BothLoaded(); }));

  EXPECT_TRUE(observer.default_success());
  EXPECT_FALSE(observer.additional_success());

  // Default engine rules should be active
  auto result = ShouldStartRequest(service.get(), EngineType::kDefault,
                                   "https://blocked-by-default.com/script.js");
  EXPECT_TRUE(result.matched);

  // Additional engine should have no rules
  result = ShouldStartRequest(service.get(), EngineType::kAdditional,
                              "https://blocked-by-default.com/script.js");
  EXPECT_FALSE(result.matched);
}

TEST_F(AdBlockServiceTest, LoadsOnlyAdditionalCachedDATFile) {
  // Create a cached DAT file only for the additional engine
  CreateCachedAdditionalDATFile("||blocked-by-additional.com^\n");

  auto service = CreateService();

  DATLoadObserver observer;
  service->AddObserver(&observer);
  ASSERT_TRUE(base::test::RunUntil([&]() { return observer.BothLoaded(); }));

  EXPECT_FALSE(observer.default_success());
  EXPECT_TRUE(observer.additional_success());

  // Additional engine rules should be active
  auto result =
      ShouldStartRequest(service.get(), EngineType::kAdditional,
                         "https://blocked-by-additional.com/script.js");
  EXPECT_TRUE(result.matched);

  // Default engine should have no rules
  result = ShouldStartRequest(service.get(), EngineType::kDefault,
                              "https://blocked-by-additional.com/script.js");
  EXPECT_FALSE(result.matched);
}

TEST_F(AdBlockServiceTest, WorksWithoutCachedDATFiles) {
  // Don't create any cached files or set timestamp - service should still work.
  auto service = CreateService();

  // Without a cached DAT, no DAT load event fires. Just verify the service
  // doesn't crash and doesn't block anything.
  auto result = ShouldStartRequest(service.get(), EngineType::kDefault,
                                   "https://example.com/script.js");
  EXPECT_FALSE(result.matched);
}

TEST_F(AdBlockServiceTest, ProviderChangeLoadsNewFilterRules) {
  // When a provider changes after the service starts, the new filter rules
  // should be loaded into the engine.
  auto service = CreateService();

  bool default_filter_list_loaded = false;
  FilterListObserver observer(
      base::BindLambdaForTesting([&](bool is_default, bool success) {
        if (is_default) {
          default_filter_list_loaded = success;
        }
      }));
  service->AddObserver(&observer);

  // Register a provider whose rules should be loaded.
  auto provider = std::make_unique<TestFiltersProvider>(
      "||new-filter-rule.com^", /*engine_is_default=*/true);
  provider->RegisterAsSourceProvider(service.get());

  ASSERT_TRUE(base::test::RunUntil([&]() {
    return default_filter_list_loaded;
  })) << "Timeout: provider change should have triggered filter set load";

  // The filter set rules should be active.
  auto result = ShouldStartRequest(service.get(), EngineType::kDefault,
                                   "https://new-filter-rule.com/script.js");
  EXPECT_TRUE(result.matched);
}

TEST_F(AdBlockServiceTest, EmptyFilterSetDoesNotCrash) {
  // An empty filter set should load successfully without crashing,
  // even when DAT caching is enabled. The serialized DAT may be empty
  // for an engine with no rules.
  auto service = CreateService();

  bool filter_list_loaded = false;
  FilterListObserver observer(
      base::BindLambdaForTesting([&](bool is_default, bool success) {
        if (is_default) {
          filter_list_loaded = true;
        }
      }));
  service->AddObserver(&observer);

  auto provider =
      std::make_unique<TestFiltersProvider>("", /*engine_is_default=*/true);
  provider->RegisterAsSourceProvider(service.get());

  ASSERT_TRUE(base::test::RunUntil([&]() { return filter_list_loaded; }))
      << "Timeout: empty filter set should still complete loading";

  // Should not block anything.
  auto result = ShouldStartRequest(service.get(), EngineType::kDefault,
                                   "https://example.com/script.js");
  EXPECT_FALSE(result.matched);

  // Check whether a DAT file was written. Even with an empty ruleset,
  // the engine serializes some data (headers), so the file should exist.
  // If Serialize returns empty for an empty engine, no file is written.
  base::FilePath dat_file =
      profile_dir_.GetPath().AppendASCII("adblock_cache/engine0.dat");
  if (base::PathExists(dat_file)) {
    // File was written — verify it's non-empty.
    std::optional<int64_t> size = base::GetFileSize(dat_file);
    EXPECT_TRUE(size.has_value());
    EXPECT_GT(*size, 0);
  }
}

TEST_F(AdBlockServiceTest, CachedDATLoadedThenProviderUpdates) {
  // When a cached DAT exists and a provider later changes, the provider's
  // filter rules should override the cached DAT rules.
  CreateCachedDefaultDATFile("||from-cache.com^\n");

  auto service = CreateService();

  DATLoadObserver dat_observer;
  service->AddObserver(&dat_observer);
  bool default_filter_list_loaded = false;
  FilterListObserver filter_observer(
      base::BindLambdaForTesting([&](bool is_default, bool success) {
        if (is_default) {
          default_filter_list_loaded = true;
        }
      }));
  service->AddObserver(&filter_observer);

  ASSERT_TRUE(
      base::test::RunUntil([&]() { return dat_observer.BothLoaded(); }));
  ASSERT_TRUE(dat_observer.default_success()) << "Default DAT failed to load";

  // The cached DAT rules should be active.
  auto result = ShouldStartRequest(service.get(), EngineType::kDefault,
                                   "https://from-cache.com/script.js");
  EXPECT_TRUE(result.matched);
  ASSERT_FALSE(default_filter_list_loaded);

  // Now register a new provider. Its rules should eventually override the
  // cached DAT.
  auto provider = std::make_unique<TestFiltersProvider>(
      "||from-filter-set.com^", /*engine_is_default=*/true);
  provider->RegisterAsSourceProvider(service.get());

  ASSERT_TRUE(base::test::RunUntil([&]() {
    return default_filter_list_loaded;
  })) << "Timeout: provider change should have triggered filter set load";

  // The provider's filter rules should now be active.
  result = ShouldStartRequest(service.get(), EngineType::kDefault,
                              "https://from-filter-set.com/script.js");
  EXPECT_TRUE(result.matched);
}

// Simulates the race condition where DAT loading fails before all providers
// are initialized. The ForceNotifyObserver fallback fires but can't trigger
// a filter set load because not all providers are ready. When the remaining
// provider initializes later, the filter list should still load.
TEST_F(AdBlockServiceTest, DATFailureFallbackWithUninitializedProvider) {
  // Write corrupt DAT files so loading will fail.
  {
    base::FilePath cache_dir =
        profile_dir_.GetPath().AppendASCII("adblock_cache");
    ASSERT_TRUE(base::CreateDirectory(cache_dir));
    ASSERT_TRUE(
        base::WriteFile(cache_dir.AppendASCII("engine0.dat"), "corrupt"));
    ASSERT_TRUE(
        base::WriteFile(cache_dir.AppendASCII("engine1.dat"), "corrupt"));
  }

  auto service = CreateService();

  // Add an uninitialized provider BEFORE DAT load failure is processed.
  // This simulates a component provider that hasn't received data yet.
  auto provider = std::make_unique<TestFiltersProvider>(
      "||late-provider.com^", /*engine_is_default=*/true);
  service->GetFiltersProviderManagerForTesting()->AddProvider(provider.get(),
                                                              true);

  DATLoadObserver dat_observer;
  service->AddObserver(&dat_observer);
  bool default_filter_list_loaded = false;
  FilterListObserver filter_observer(
      base::BindLambdaForTesting([&](bool is_default, bool success) {
        if (is_default) {
          default_filter_list_loaded = true;
        }
      }));
  service->AddObserver(&filter_observer);

  // Wait for DAT load to complete (and fail).
  ASSERT_TRUE(base::test::RunUntil([&]() { return dat_observer.BothLoaded(); }))
      << "Timeout waiting for DAT load";

  // DAT load failed, ForceNotifyObserver ran but couldn't trigger filter set
  // load because our provider isn't initialized yet.
  EXPECT_FALSE(default_filter_list_loaded)
      << "Filter set should not have loaded while provider is uninitialized";

  // Now initialize the provider — this should trigger OnChanged and the
  // filter list should load.
  provider->Initialize();

  ASSERT_TRUE(base::test::RunUntil([&]() {
    return default_filter_list_loaded;
  })) << "Timeout: filter list should load after late provider initializes";

  // The late provider's rules should be active.
  auto result = ShouldStartRequest(service.get(), EngineType::kDefault,
                                   "https://late-provider.com/script.js");
  EXPECT_TRUE(result.matched);
}

TEST_F(AdBlockServiceDATCacheDisabledTest, CachedDATIgnoredWhenFlagDisabled) {
  // Create cached DAT files and set valid timestamp.
  CreateCachedDATFiles("||from-cache.com^\n", "");

  auto service = CreateService();

  // Register a provider for the default engine -- with the flag disabled,
  // filter set loading should always proceed regardless of cache state.
  bool default_filter_list_loaded = false;
  FilterListObserver observer(
      base::BindLambdaForTesting([&](bool is_default, bool success) {
        if (is_default) {
          default_filter_list_loaded = success;
        }
      }));
  service->AddObserver(&observer);

  auto provider = std::make_unique<TestFiltersProvider>(
      "||from-filter-set.com^", /*engine_is_default=*/true);
  provider->RegisterAsSourceProvider(service.get());

  ASSERT_TRUE(base::test::RunUntil([&]() {
    return default_filter_list_loaded;
  })) << "Filter set should load even when cache timestamp is set";

  // The filter set rules should be active, not the cached DAT rules.
  auto result = ShouldStartRequest(service.get(), EngineType::kDefault,
                                   "https://from-filter-set.com/script.js");
  EXPECT_TRUE(result.matched);

  // The cached DAT rules should NOT be loaded.
  result = ShouldStartRequest(service.get(), EngineType::kDefault,
                              "https://from-cache.com/script.js");
  EXPECT_FALSE(result.matched);
}

TEST_F(AdBlockServiceDATCacheDisabledTest,
       FilterSetAlwaysLoadsWhenFlagDisabled) {
  auto service = CreateService();

  bool default_filter_list_loaded = false;
  FilterListObserver observer(
      base::BindLambdaForTesting([&](bool is_default, bool success) {
        if (is_default) {
          default_filter_list_loaded = success;
        }
      }));
  service->AddObserver(&observer);

  auto provider = std::make_unique<TestFiltersProvider>(
      "||should-still-load.com^", /*engine_is_default=*/true);
  provider->RegisterAsSourceProvider(service.get());

  ASSERT_TRUE(base::test::RunUntil([&]() {
    return default_filter_list_loaded;
  })) << "Filter set should load when DAT cache flag is disabled";

  auto result = ShouldStartRequest(service.get(), EngineType::kDefault,
                                   "https://should-still-load.com/script.js");
  EXPECT_TRUE(result.matched);
}

}  // namespace brave_shields
