// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/components/brave_shields/content/browser/ad_block_subscription_service_manager.h"

#include <algorithm>
#include <memory>
#include <optional>
#include <string_view>
#include <utility>

#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/json/values_util.h"
#include "base/scoped_observation.h"
#include "base/test/bind.h"
#include "base/test/scoped_feature_list.h"
#include "base/test/task_environment.h"
#include "base/time/time.h"
#include "base/values.h"
#include "brave/components/brave_shields/content/browser/ad_block_service.h"
#include "brave/components/brave_shields/content/browser/ad_block_subscription_download_manager.h"
#include "brave/components/brave_shields/content/test/test_filters_provider.h"
#include "brave/components/brave_shields/core/browser/ad_block_filters_provider.h"
#include "brave/components/brave_shields/core/browser/ad_block_filters_provider_manager.h"
#include "brave/components/brave_shields/core/browser/ad_block_list_p3a.h"
#include "brave/components/brave_shields/core/common/features.h"
#include "brave/components/brave_shields/core/common/pref_names.h"
#include "brave/components/velmren/public_filters.h"
#include "components/keyed_service/core/keyed_service.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/scoped_user_pref_update.h"
#include "components/prefs/testing_pref_service.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace brave_shields {
namespace {

constexpr std::string_view kEasyListUrl =
    "https://easylist.to/easylist/easylist.txt";
constexpr std::string_view kAdGuardAnnoyancesUrl =
    "https://filters.adtidy.org/extension/ublock/filters/21.txt";
constexpr std::string_view kOtherAnnoyancesUrl =
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/"
    "annoyances-others.txt";

class SubscriptionEngineObserver : public AdBlockFiltersProvider::Observer {
 public:
  void OnChanged(bool is_default_engine) override {
    (is_default_engine ? default_changes : additional_changes)++;
  }

  int default_changes = 0;
  int additional_changes = 0;
};

std::optional<SubscriptionInfo> FindSubscription(
    AdBlockSubscriptionServiceManager& manager,
    std::string_view url) {
  for (const auto& info : manager.GetSubscriptions()) {
    if (info.subscription_url == GURL(url)) {
      return info;
    }
  }
  return std::nullopt;
}

}  // namespace

class AdBlockSubscriptionServiceManagerTest : public testing::Test {
 public:
  AdBlockSubscriptionServiceManagerTest() {
    feature_list_.InitAndDisableFeature(features::kAdblockDATCache);
  }

 protected:
  void SetUp() override {
    RegisterPrefsForAdBlockService(prefs_.registry());
    ASSERT_TRUE(profile_dir_.CreateUniqueTempDir());
    list_p3a_ = std::make_unique<AdBlockListP3A>(&prefs_);
    provider_manager_ = std::make_unique<AdBlockFiltersProviderManager>();
    download_manager_ = std::make_unique<AdBlockSubscriptionDownloadManager>(
        nullptr, task_environment_.GetMainThreadTaskRunner());
    // Exercise seeding without a download service or any network requests.
    static_cast<KeyedService*>(download_manager_.get())->Shutdown();
  }

  std::unique_ptr<AdBlockSubscriptionServiceManager> CreateManager() {
    return std::make_unique<AdBlockSubscriptionServiceManager>(
        &prefs_, provider_manager_.get(),
        base::BindOnce(
            [](AdBlockSubscriptionDownloadManager* download_manager,
               base::OnceCallback<void(AdBlockSubscriptionDownloadManager*)>
                   callback) { std::move(callback).Run(download_manager); },
            download_manager_.get()),
        profile_dir_.GetPath(), list_p3a_.get());
  }

  void SetSubscription(std::string_view url,
                       bool enabled,
                       std::string_view title) {
    base::DictValue subscription;
    subscription.Set("enabled", enabled);
    subscription.Set("last_update_attempt", base::TimeToValue(base::Time()));
    subscription.Set("last_successful_update_attempt",
                     base::TimeToValue(base::Time()));
    subscription.Set("expires", kSubscriptionDefaultExpiresHours);
    subscription.Set("title", title);
    ScopedDictPrefUpdate update(&prefs_, prefs::kAdBlockListSubscriptions);
    update->Set(url, std::move(subscription));
  }

  base::test::TaskEnvironment task_environment_{
      base::test::TaskEnvironment::TimeSource::MOCK_TIME};
  base::test::ScopedFeatureList feature_list_;
  TestingPrefServiceSimple prefs_;
  base::ScopedTempDir profile_dir_;
  std::unique_ptr<AdBlockListP3A> list_p3a_;
  std::unique_ptr<AdBlockFiltersProviderManager> provider_manager_;
  std::unique_ptr<AdBlockSubscriptionDownloadManager> download_manager_;
};

TEST_F(AdBlockSubscriptionServiceManagerTest,
       FreshProfileSeedsEntireCatalogBeforeMarkingComplete) {
  SubscriptionEngineObserver observer;
  base::ScopedObservation<AdBlockFiltersProvider,
                          AdBlockFiltersProvider::Observer>
      observation(&observer);
  observation.Observe(provider_manager_.get());
  bool completion_observed = false;
  PrefChangeRegistrar registrar;
  registrar.Init(&prefs_);
  registrar.Add(prefs::kAdBlockPublicListsSeededVersion,
                base::BindLambdaForTesting([&]() {
                  completion_observed = true;
                  const auto& subscriptions =
                      prefs_.GetDict(prefs::kAdBlockListSubscriptions);
                  EXPECT_EQ(subscriptions.size(), 28u);
                  for (const auto& list : velmren::GetPublicFilterLists()) {
                    const auto* subscription = subscriptions.FindDict(list.url);
                    ASSERT_TRUE(subscription);
                    EXPECT_EQ(subscription->FindBool("enabled"), true);
                    const auto* title = subscription->FindString("title");
                    ASSERT_TRUE(title);
                    EXPECT_EQ(*title, list.title);
                  }
                }));

  auto manager = CreateManager();

  EXPECT_TRUE(completion_observed);
  EXPECT_TRUE(manager->is_initialized());
  EXPECT_TRUE(prefs_.GetBoolean(prefs::kAdBlockPublicListsSeeded));
  EXPECT_TRUE(prefs_.GetBoolean(prefs::kAdBlockPublicListsDefaultCacheDirty));
  EXPECT_TRUE(
      prefs_.GetBoolean(prefs::kAdBlockPublicListsAdditionalCacheDirty));
  EXPECT_EQ(prefs_.GetInteger(prefs::kAdBlockPublicListsSeededVersion),
            velmren::kPublicFilterCatalogVersion);
  EXPECT_EQ(manager->GetSubscriptions().size(), 28u);
  const auto catalog = velmren::GetPublicFilterLists();
  const auto default_count = static_cast<size_t>(std::ranges::count_if(
      catalog, &velmren::PublicFilterList::is_default_engine));
  EXPECT_EQ(provider_manager_->GetProviders(true).size(), default_count);
  EXPECT_EQ(provider_manager_->GetProviders(false).size(),
            catalog.size() - default_count);
  EXPECT_EQ(observer.default_changes, 1);
  EXPECT_EQ(observer.additional_changes, 1);
}

TEST(AdBlockCatalogCacheTest, ReloadRemainsRequiredUntilProvidersInitialize) {
  base::test::ScopedFeatureList feature_list;
  feature_list.InitAndEnableFeature(features::kAdblockDATCache);
  AdBlockFiltersProviderManager manager;
  TestFiltersProvider provider("", false);
  manager.AddProvider(&provider, false);
  SubscriptionEngineObserver observer;
  base::ScopedObservation<AdBlockFiltersProvider,
                          AdBlockFiltersProvider::Observer>
      observation(&observer);
  observation.Observe(&manager);

  const auto initial_generation = manager.GetFilterSetGeneration(false);
  manager.RequireFilterSetReload(false);
  EXPECT_EQ(observer.additional_changes, 0);
  EXPECT_EQ(manager.GetFilterSetGeneration(false), initial_generation + 1);
  EXPECT_EQ(manager.GetFilterSetGeneration(true), 0u);
  provider.Initialize();

  EXPECT_EQ(observer.additional_changes, 1);
  EXPECT_EQ(observer.default_changes, 0);
  manager.RemoveProvider(&provider, false);
}

TEST(AdBlockCatalogCacheTest, GenerationTracksProviderSetAndContentChanges) {
  AdBlockFiltersProviderManager manager;
  TestFiltersProvider provider("", false);
  const auto initial_generation = manager.GetFilterSetGeneration(false);
  manager.AddProvider(&provider, false);
  EXPECT_EQ(manager.GetFilterSetGeneration(false), initial_generation + 1);
  provider.Initialize();
  EXPECT_EQ(manager.GetFilterSetGeneration(false), initial_generation + 2);
  provider.SimulateUpdate();
  EXPECT_EQ(manager.GetFilterSetGeneration(false), initial_generation + 3);
  manager.RemoveProvider(&provider, false);
  EXPECT_EQ(manager.GetFilterSetGeneration(false), initial_generation + 4);
  EXPECT_EQ(manager.GetFilterSetGeneration(true), 0u);
}

TEST_F(AdBlockSubscriptionServiceManagerTest,
       LegacySeedOnlyAddsNewListsAndPreservesDisabledSubscriptions) {
  prefs_.SetBoolean(prefs::kAdBlockPublicListsSeeded, true);
  SetSubscription(kEasyListUrl, false, "My EasyList title");
  SetSubscription(kAdGuardAnnoyancesUrl, false, "My annoyances title");
  SubscriptionEngineObserver observer;
  base::ScopedObservation<AdBlockFiltersProvider,
                          AdBlockFiltersProvider::Observer>
      observation(&observer);
  observation.Observe(provider_manager_.get());

  auto manager = CreateManager();

  EXPECT_EQ(manager->GetSubscriptions().size(), 3u);
  for (const auto& list : velmren::GetPublicFilterLists()) {
    if (list.introduced_version == 1 && list.url != kEasyListUrl) {
      EXPECT_FALSE(FindSubscription(*manager, list.url));
    }
  }
  const auto easylist = FindSubscription(*manager, kEasyListUrl);
  ASSERT_TRUE(easylist);
  EXPECT_FALSE(easylist->enabled);
  EXPECT_EQ(easylist->title, "My EasyList title");
  const auto adguard = FindSubscription(*manager, kAdGuardAnnoyancesUrl);
  ASSERT_TRUE(adguard);
  EXPECT_FALSE(adguard->enabled);
  EXPECT_EQ(adguard->title, "My annoyances title");
  const auto other = FindSubscription(*manager, kOtherAnnoyancesUrl);
  ASSERT_TRUE(other);
  EXPECT_TRUE(other->enabled);
  EXPECT_EQ(prefs_.GetInteger(prefs::kAdBlockPublicListsSeededVersion),
            velmren::kPublicFilterCatalogVersion);
  EXPECT_TRUE(provider_manager_->GetProviders(true).empty());
  EXPECT_EQ(provider_manager_->GetProviders(false).size(), 1u);
  EXPECT_EQ(observer.default_changes, 0);
  EXPECT_EQ(observer.additional_changes, 1);
  EXPECT_FALSE(prefs_.GetBoolean(prefs::kAdBlockPublicListsDefaultCacheDirty));
  EXPECT_TRUE(
      prefs_.GetBoolean(prefs::kAdBlockPublicListsAdditionalCacheDirty));
}

TEST_F(AdBlockSubscriptionServiceManagerTest,
       CompletedCatalogPreservesDeletedAndDisabledListsAfterRestart) {
  auto manager = CreateManager();
  manager->EnableSubscription(GURL(kAdGuardAnnoyancesUrl), false);
  manager->DeleteSubscription(GURL(kOtherAnnoyancesUrl));
  manager->DeleteSubscription(GURL(kEasyListUrl));
  const auto saved_subscriptions =
      prefs_.GetDict(prefs::kAdBlockListSubscriptions).Clone();
  manager.reset();

  manager = CreateManager();

  EXPECT_EQ(manager->GetSubscriptions().size(), 26u);
  EXPECT_FALSE(FindSubscription(*manager, kOtherAnnoyancesUrl));
  EXPECT_FALSE(FindSubscription(*manager, kEasyListUrl));
  const auto adguard = FindSubscription(*manager, kAdGuardAnnoyancesUrl);
  ASSERT_TRUE(adguard);
  EXPECT_FALSE(adguard->enabled);
  EXPECT_EQ(prefs_.GetDict(prefs::kAdBlockListSubscriptions),
            saved_subscriptions);
  EXPECT_EQ(prefs_.GetInteger(prefs::kAdBlockPublicListsSeededVersion),
            velmren::kPublicFilterCatalogVersion);
}

TEST_F(AdBlockSubscriptionServiceManagerTest,
       FutureCompletedVersionPreventsReseedingAndIsNotDowngraded) {
  const int future_version = velmren::kPublicFilterCatalogVersion + 1;
  prefs_.SetInteger(prefs::kAdBlockPublicListsSeededVersion, future_version);
  SetSubscription(kAdGuardAnnoyancesUrl, false, "My annoyances title");

  auto manager = CreateManager();

  EXPECT_EQ(manager->GetSubscriptions().size(), 1u);
  const auto adguard = FindSubscription(*manager, kAdGuardAnnoyancesUrl);
  ASSERT_TRUE(adguard);
  EXPECT_FALSE(adguard->enabled);
  EXPECT_EQ(prefs_.GetInteger(prefs::kAdBlockPublicListsSeededVersion),
            future_version);
  EXPECT_TRUE(provider_manager_->GetProviders(true).empty());
  EXPECT_TRUE(provider_manager_->GetProviders(false).empty());
}

}  // namespace brave_shields
