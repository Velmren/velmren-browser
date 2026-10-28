/* Copyright (c) 2025 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/toolbar/brave_location_bar_model_delegate.h"

#include "base/test/scoped_feature_list.h"
#include "brave/browser/brave_shields/brave_shields_tab_helper.h"
#include "brave/browser/ui/page_info/features.h"
#include "brave/browser/ui/views/brave_actions/brave_shields_action_controller.h"
#include "brave/components/vector_icons/vector_icons.h"
#include "brave/ui/color/nala/nala_color_id.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_location_bar_model_delegate.h"
#include "chrome/browser/ui/color/chrome_color_id.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/test/base/in_process_browser_test.h"
#include "chrome/test/base/ui_test_utils.h"
#include "content/public/browser/web_contents.h"
#include "content/public/test/browser_test.h"
#include "net/dns/mock_host_resolver.h"
#include "net/test/embedded_test_server/embedded_test_server.h"
#include "ui/color/color_provider.h"
#include "ui/gfx/image/image_unittest_util.h"
#include "ui/gfx/paint_vector_icon.h"

using security_state::SecurityLevel;

class MockBraveLocationBarModelDelegate
    : public BrowserLocationBarModelDelegate {
 public:
  using BrowserLocationBarModelDelegate::BrowserLocationBarModelDelegate;
  ~MockBraveLocationBarModelDelegate() override = default;

  security_state::SecurityLevel GetSecurityLevel() const override {
    if (security_level_) {
      return *security_level_;
    }
    return BrowserLocationBarModelDelegate::GetSecurityLevel();
  }

  void SetSecurityLevel(SecurityLevel level) { security_level_ = level; }

 private:
  std::optional<SecurityLevel> security_level_;
};

class BraveLocationBarModelDelegateBrowserTest : public InProcessBrowserTest {
 public:
  BraveLocationBarModelDelegateBrowserTest() = default;

  void SetUpOnMainThread() override {
    InProcessBrowserTest::SetUpOnMainThread();

    host_resolver()->AddRule("*", "127.0.0.1");
    ASSERT_TRUE(embedded_https_test_server().Start());
    ASSERT_TRUE(embedded_test_server()->Start());

    delegate_ = std::make_unique<MockBraveLocationBarModelDelegate>(
        browser()->tab_strip_model());
  }

  void TearDownOnMainThread() override {
    delegate_.reset();
    InProcessBrowserTest::TearDownOnMainThread();
  }

  void NavigateToHTTPS() {
    GURL https_url =
        embedded_https_test_server().GetURL("example.com", "/simple.html");
    ASSERT_TRUE(ui_test_utils::NavigateToURL(browser(), https_url));
  }

  void NavigateToHTTP() {
    GURL http_url =
        embedded_test_server()->GetURL("example.com", "/simple.html");
    ASSERT_TRUE(ui_test_utils::NavigateToURL(browser(), http_url));
  }

  content::WebContents* GetActiveWebContents() {
    return browser()->tab_strip_model()->GetActiveWebContents();
  }

  brave_shields::BraveShieldsTabHelper* GetShieldsHelper() {
    return brave_shields::BraveShieldsTabHelper::FromWebContents(
        GetActiveWebContents());
  }

 protected:
  std::unique_ptr<MockBraveLocationBarModelDelegate> delegate_;
};

IN_PROC_BROWSER_TEST_F(BraveLocationBarModelDelegateBrowserTest,
                       ShieldsUseProductArtwork) {
  BraveShieldsActionController controller(browser(), {});
  const auto& colors = GetActiveWebContents()->GetColorProvider();
  const auto enabled = controller.GetIconImage(true);
  const auto disabled = controller.GetIconImage(false);
  const auto expected_enabled = gfx::CreateVectorIcon(
      kLeoBraveIconOnlyFaceIcon, enabled.width(),
      colors.GetColor(kColorOmniboxResultsIcon));
  const auto expected_disabled = gfx::CreateVectorIcon(
      kLeoBraveIconOnlyFaceDisabledIcon, disabled.width(),
      colors.GetColor(nala::kColorIconDisabled));
  EXPECT_TRUE(gfx::test::AreBitmapsEqual(*enabled.bitmap(),
                                       *expected_enabled.bitmap()));
  EXPECT_TRUE(gfx::test::AreBitmapsEqual(*disabled.bitmap(),
                                       *expected_disabled.bitmap()));
  EXPECT_FALSE(gfx::test::AreBitmapsEqual(*enabled.bitmap(), *disabled.bitmap()));
}

IN_PROC_BROWSER_TEST_F(BraveLocationBarModelDelegateBrowserTest,
                       ReturnsProductIconForInternalPage) {
  ASSERT_TRUE(
      ui_test_utils::NavigateToURL(browser(), GURL("chrome://settings/")));
  EXPECT_EQ(delegate_->GetVectorIconOverride(), &kLeoBraveIconOnlyFaceIcon);
}

IN_PROC_BROWSER_TEST_F(BraveLocationBarModelDelegateBrowserTest,
                       ReturnsNullForNonSecurePage) {
  NavigateToHTTP();
  const gfx::VectorIcon* icon = delegate_->GetVectorIconOverride();
  EXPECT_EQ(icon, nullptr);
}

IN_PROC_BROWSER_TEST_F(BraveLocationBarModelDelegateBrowserTest,
                       ReturnsTuneIconForSecurePage) {
  NavigateToHTTPS();
  EXPECT_EQ(delegate_->GetSecurityLevel(), SecurityLevel::SECURE);
  const gfx::VectorIcon* icon = delegate_->GetVectorIconOverride();
  EXPECT_EQ(icon, &kLeoTuneSmallIcon);
}

IN_PROC_BROWSER_TEST_F(BraveLocationBarModelDelegateBrowserTest,
                       ReturnsNullForNonSecureHttpsPage) {
  NavigateToHTTPS();

  delegate_->SetSecurityLevel(SecurityLevel::NONE);
  EXPECT_EQ(delegate_->GetVectorIconOverride(), nullptr);

  delegate_->SetSecurityLevel(SecurityLevel::DANGEROUS);
  EXPECT_EQ(delegate_->GetVectorIconOverride(), nullptr);

  delegate_->SetSecurityLevel(SecurityLevel::WARNING);
  EXPECT_EQ(delegate_->GetVectorIconOverride(), nullptr);
}

class BraveLocationBarModelDelegateShieldsBrowserTest
    : public BraveLocationBarModelDelegateBrowserTest {
 public:
  BraveLocationBarModelDelegateShieldsBrowserTest() {
    feature_list.InitAndEnableFeature(
        page_info::features::kShowBraveShieldsInPageInfo);
  }

  ~BraveLocationBarModelDelegateShieldsBrowserTest() override = default;

 protected:
  base::test::ScopedFeatureList feature_list;
};

IN_PROC_BROWSER_TEST_F(BraveLocationBarModelDelegateShieldsBrowserTest,
                       ReturnsShieldDoneIconWhenShieldsEnabled) {
  NavigateToHTTPS();

  auto* shields_helper = GetShieldsHelper();
  ASSERT_TRUE(shields_helper);
  EXPECT_TRUE(shields_helper->IsBraveShieldsEnabled());

  const gfx::VectorIcon* icon = delegate_->GetVectorIconOverride();
  EXPECT_EQ(icon, &kLeoShieldDoneIcon);
}

IN_PROC_BROWSER_TEST_F(BraveLocationBarModelDelegateShieldsBrowserTest,
                       ReturnsShieldDisabledIconWhenShieldsDisabled) {
  NavigateToHTTPS();

  auto* shields_helper = GetShieldsHelper();
  ASSERT_TRUE(shields_helper);

  shields_helper->SetBraveShieldsEnabled(false);
  EXPECT_FALSE(shields_helper->IsBraveShieldsEnabled());

  const gfx::VectorIcon* icon = delegate_->GetVectorIconOverride();
  EXPECT_EQ(icon, &kLeoShieldDisableFilledIcon);
}
