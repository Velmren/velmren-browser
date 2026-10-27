/* Copyright (c) 2022 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <memory>

#include "base/feature_list.h"
#include "base/test/scoped_feature_list.h"
#include "base/time/time.h"
#include "brave/components/brave_search_conversion/features.h"
#include "brave/components/brave_search_conversion/pref_names.h"
#include "brave/components/brave_search_conversion/types.h"
#include "brave/components/brave_search_conversion/utils.h"
#include "brave/components/search_engines/brave_prepopulated_engines.h"
#include "components/prefs/testing_pref_service.h"
#include "components/search_engines/search_engines_test_environment.h"
#include "components/search_engines/template_url.h"
#include "components/search_engines/template_url_data_util.h"
#include "components/search_engines/template_url_service.h"
#include "content/public/test/browser_task_environment.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace brave_search_conversion {

class BraveSearchConversionTest : public testing::Test {
 public:
  BraveSearchConversionTest()
      : task_environment_(base::test::TaskEnvironment::TimeSource::MOCK_TIME) {}

  void SetUp() override {
    RegisterPrefs(pref_service_.registry());
    auto provider_data = TemplateURLDataFromPrepopulatedEngine(
        TemplateURLPrepopulateData::brave_search);
    brave_search_template_url_ = std::make_unique<TemplateURL>(*provider_data);
    provider_data = TemplateURLDataFromPrepopulatedEngine(
        TemplateURLPrepopulateData::brave_search_tor);
    brave_search_tor_template_url_ =
        std::make_unique<TemplateURL>(*provider_data);
    provider_data = TemplateURLDataFromPrepopulatedEngine(
        TemplateURLPrepopulateData::brave_bing);
    bing_template_url_ = std::make_unique<TemplateURL>(*provider_data);
    provider_data = TemplateURLDataFromPrepopulatedEngine(
        TemplateURLPrepopulateData::duckduckgo);
    ddg_template_url_ = std::make_unique<TemplateURL>(*provider_data);
  }

  void ConfigureDDGAsDefaultProvider() {
    search_engines_test_environment_.template_url_service()
        ->SetUserSelectedDefaultSearchProvider(ddg_template_url_.get());
  }

  void ConfigureBingAsDefaultProvider() {
    search_engines_test_environment_.template_url_service()
        ->SetUserSelectedDefaultSearchProvider(bing_template_url_.get());
  }

  void ConfigureBraveSearchAsDefaultProvider(bool tor) {
    search_engines_test_environment_.template_url_service()
        ->SetUserSelectedDefaultSearchProvider(
            tor ? brave_search_tor_template_url_.get()
                : brave_search_template_url_.get());
  }

 protected:
  content::BrowserTaskEnvironment task_environment_;
  std::unique_ptr<TemplateURL> brave_search_template_url_;
  std::unique_ptr<TemplateURL> brave_search_tor_template_url_;
  std::unique_ptr<TemplateURL> bing_template_url_;
  std::unique_ptr<TemplateURL> ddg_template_url_;
  TestingPrefServiceSimple pref_service_;
  search_engines::SearchEnginesTestEnvironment search_engines_test_environment_;
};

TEST_F(BraveSearchConversionTest, VelmrenSuppressesForcedPromotions) {
  base::test::ScopedFeatureList feature_list;
  feature_list.InitWithFeatures(
      {features::kOmniboxBanner, features::kOmniboxDDGBanner, features::kNTP},
      {});
  ConfigureBingAsDefaultProvider();

  auto* service = search_engines_test_environment_.template_url_service();
  EXPECT_FALSE(IsBraveSearchConversionFeatureEnabled());
  EXPECT_FALSE(IsNTPPromotionEnabled(&pref_service_, service));
  EXPECT_EQ(GetConversionType(&pref_service_, service), ConversionType::kNone);

  ConfigureDDGAsDefaultProvider();
  EXPECT_EQ(GetConversionType(&pref_service_, service), ConversionType::kNone);
}

TEST_F(BraveSearchConversionTest, DefaultValueTest) {
  EXPECT_FALSE(base::FeatureList::IsEnabled(features::kOmniboxBanner));
  EXPECT_FALSE(base::FeatureList::IsEnabled(features::kOmniboxDDGBanner));
  EXPECT_FALSE(base::FeatureList::IsEnabled(features::kNTP));
  EXPECT_EQ(ConversionType::kNone,
            GetConversionType(
                &pref_service_,
                search_engines_test_environment_.template_url_service()));
  EXPECT_EQ(GURL("https://search.brave.com/search?q=brave&action=makeDefault"),
            GetPromoURL(u"brave"));
}

TEST_F(BraveSearchConversionTest,
       ConversionAndNTPPromotionDisabledForEveryProviderAndFeatureCombination) {
  auto* service = search_engines_test_environment_.template_url_service();
  for (int feature_mask = 0; feature_mask < 8; ++feature_mask) {
    SCOPED_TRACE(feature_mask);
    base::test::ScopedFeatureList feature_list;
    feature_list.InitWithFeatureStates(
        {{features::kOmniboxBanner, (feature_mask & 1) != 0},
         {features::kOmniboxDDGBanner, (feature_mask & 2) != 0},
         {features::kNTP, (feature_mask & 4) != 0}});

    EXPECT_FALSE(IsBraveSearchConversionFeatureEnabled());
    const auto expect_suppressed = [&]() {
      EXPECT_EQ(ConversionType::kNone,
                GetConversionType(&pref_service_, service));
      EXPECT_FALSE(IsNTPPromotionEnabled(&pref_service_, service));
    };

    ConfigureBingAsDefaultProvider();
    expect_suppressed();
    ConfigureDDGAsDefaultProvider();
    expect_suppressed();
    ConfigureBraveSearchAsDefaultProvider(false);
    expect_suppressed();
    ConfigureBraveSearchAsDefaultProvider(true);
    expect_suppressed();

    // Suppressed requests must not advance the DDG banner rotation state.
    EXPECT_EQ(pref_service_.GetInteger(prefs::kDDGBannerTypeIndex), 0);
    EXPECT_TRUE(pref_service_.GetTime(prefs::kLatestDDGBannerTypeFirstShownTime)
                    .is_null());
  }
}

TEST_F(BraveSearchConversionTest, DismissalAndDelayNeverReenablePromotions) {
  base::test::ScopedFeatureList feature_list;
  feature_list.InitWithFeaturesAndParameters(
      {{features::kOmniboxBanner, {{features::kBannerTypeParamName, "type_B"}}},
       {features::kOmniboxDDGBanner, {}},
       {features::kNTP, {}}},
      {});
  ConfigureDDGAsDefaultProvider();
  auto* service = search_engines_test_environment_.template_url_service();

  EXPECT_FALSE(pref_service_.GetBoolean(prefs::kDismissed));
  EXPECT_TRUE(pref_service_.GetTime(prefs::kMaybeLaterClickedTime).is_null());
  const base::Time clicked_time = base::Time::Now();
  SetMaybeLater(&pref_service_);
  EXPECT_EQ(pref_service_.GetTime(prefs::kMaybeLaterClickedTime), clicked_time);

  for (const auto delay : {base::Days(2), base::Days(1) + base::Milliseconds(1),
                           base::Minutes(1), base::Minutes(1)}) {
    task_environment_.AdvanceClock(delay);
    EXPECT_EQ(ConversionType::kNone,
              GetConversionType(&pref_service_, service));
    EXPECT_FALSE(IsNTPPromotionEnabled(&pref_service_, service));
  }
  EXPECT_EQ(pref_service_.GetInteger(prefs::kDDGBannerTypeIndex), 0);
  EXPECT_TRUE(pref_service_.GetTime(prefs::kLatestDDGBannerTypeFirstShownTime)
                  .is_null());

  SetDismissed(&pref_service_);
  EXPECT_TRUE(pref_service_.GetBoolean(prefs::kDismissed));
  EXPECT_EQ(ConversionType::kNone, GetConversionType(&pref_service_, service));
  EXPECT_FALSE(IsNTPPromotionEnabled(&pref_service_, service));
}

}  // namespace brave_search_conversion
