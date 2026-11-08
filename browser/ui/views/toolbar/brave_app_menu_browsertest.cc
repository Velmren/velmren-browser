/* Copyright (c) 2023 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include <array>
#include <optional>

#include "base/check.h"
#include "base/memory/raw_ptr.h"
#include "base/test/scoped_feature_list.h"
#include "brave/app/brave_command_ids.h"
#include "brave/browser/ui/brave_browser_command_controller.h"
#include "brave/browser/ui/views/toolbar/brave_browser_app_menu_button.h"
#include "brave/components/brave_vpn/common/buildflags/buildflags.h"
#include "brave/components/skus/common/features.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "chrome/browser/ui/layout_constants.h"
#include "chrome/browser/ui/toolbar/app_menu_icon_controller.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/toolbar/app_menu.h"
#include "chrome/browser/ui/views/toolbar/browser_app_menu_button.h"
#include "chrome/browser/ui/views/toolbar/toolbar_view.h"
#include "chrome/test/base/in_process_browser_test.h"
#include "chrome/test/base/ui_test_utils.h"
#include "content/public/test/browser_test.h"
#include "content/public/test/test_utils.h"
#include "ui/base/ui_base_features.h"
#include "ui/views/controls/button/toggle_button.h"
#include "ui/views/controls/menu/menu_item_view.h"
#include "ui/views/controls/menu/menu_runner.h"
#include "ui/views/view_utils.h"

#if BUILDFLAG(IS_WIN)
#include "base/test/run_until.h"
#include "brave/browser/ui/toolbar/brave_app_menu_model.h"
#include "brave/browser/ui/toolbar/velmren_update_menu.h"
#include "brave/browser/velmren_update_status.h"
#include "brave/grit/brave_generated_resources.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/pref_names.h"
#include "chrome/common/webui_url_constants.h"
#include "components/prefs/pref_service.h"
#include "content/public/test/test_navigation_observer.h"
#include "ui/accessibility/ax_node_data.h"
#include "ui/accessibility/platform/ax_platform.h"
#include "ui/accessibility/platform/ax_platform_node_win.h"
#include "ui/base/l10n/l10n_util.h"
#include "ui/views/accessibility/view_accessibility.h"
#include "url/gurl.h"

namespace velmren::delivery {

class UpdateStatusMonitorTestApi {
 public:
  UpdateStatusMonitorTestApi()
      : monitor_(UpdateStatusMonitor::GetInstance()),
        saved_root_(monitor_->root_),
        saved_status_(monitor_->status_) {
    CHECK(!monitor_->supported());
    monitor_->root_ = base::FilePath(FILE_PATH_LITERAL("C:\\velmren-ui-test"));
  }

  ~UpdateStatusMonitorTestApi() {
    // About can request an async refresh; it must not escape this fake state.
    monitor_->timer_.Stop();
    monitor_->weak_factory_.InvalidateWeakPtrs();
    monitor_->reading_ = false;
    monitor_->starting_check_ = false;
    monitor_->root_ = saved_root_;
    monitor_->status_ = saved_status_;
    monitor_->observers_.Notify();
  }

  void SetPhase(UpdatePhase phase) {
    monitor_->status_ = {};
    monitor_->status_.phase = phase;
    monitor_->status_.installed_version = "0.18.0.0";
    monitor_->status_.available_version = "0.18.0.1";
    monitor_->observers_.Notify();
  }

 private:
  const raw_ptr<UpdateStatusMonitor> monitor_;
  const base::FilePath saved_root_;
  const UpdateStatus saved_status_;
};

}  // namespace velmren::delivery
#endif  // BUILDFLAG(IS_WIN)

#if BUILDFLAG(ENABLE_BRAVE_VPN)
#include "brave/browser/brave_vpn/brave_vpn_service_factory.h"
#include "brave/components/brave_vpn/browser/brave_vpn_service.h"
#include "brave/components/brave_vpn/common/features.h"
#endif

class BraveAppMenuBrowserTest : public InProcessBrowserTest {
 public:
  BraveAppMenuBrowserTest() {
#if BUILDFLAG(ENABLE_BRAVE_VPN)
    scoped_feature_list_.InitWithFeatures(
        {skus::features::kSkusFeature, brave_vpn::features::kBraveVPN}, {});
#endif
  }

  ~BraveAppMenuBrowserTest() override = default;

#if BUILDFLAG(IS_WIN)
  void TearDownOnMainThread() override {
    // External UIA clients can retain providers after browser windows close.
    // Disconnect them after all UI and accessibility assertions have run.
    ui::AXPlatform::GetInstance().DisableActiveUiaProvider();
    InProcessBrowserTest::TearDownOnMainThread();
  }

  void PostRunTestOnMainThread() override {
    InProcessBrowserTest::PostRunTestOnMainThread();
    // Follow DumpAccessibilityEventsViewsTestBase: allow COM releases to finish
    // after windows close, while retaining the platform-node leak checks.
    EXPECT_TRUE(base::test::RunUntil(
        [] { return ui::AXPlatformNodeWin::GetCounts().ghost_nodes == 0u; }))
        << ui::AXPlatformNodeWin::GetCounts().ghost_nodes
        << " AXPlatformNodeWin COM references are still alive.";
  }
#endif  // BUILDFLAG(IS_WIN)

  BrowserAppMenuButton* menu_button() {
    return BrowserView::GetBrowserViewForBrowser(browser())
        ->toolbar()
        ->app_menu_button();
  }

#if BUILDFLAG(ENABLE_BRAVE_VPN)
  void SetPurchasedUserForBraveVPN(BrowserWindowInterface* browser,
                                   bool purchased) {
    auto* service =
        brave_vpn::BraveVpnServiceFactory::GetForProfile(browser->GetProfile());
    ASSERT_TRUE(!!service);
    auto target_state = purchased
                            ? brave_vpn::mojom::PurchasedState::PURCHASED
                            : brave_vpn::mojom::PurchasedState::NOT_PURCHASED;
    service->SetPurchasedStateForTesting(skus::GetDefaultEnvironment(),
                                         target_state);
    // Call explicitely to update vpn commands status because mojo works in
    // async way.
    static_cast<chrome::BraveBrowserCommandController*>(
        chrome::BrowserCommandController::From(browser))
        ->OnPurchasedStateChanged(target_state, std::nullopt);
  }

  base::test::ScopedFeatureList scoped_feature_list_;
#endif
};

IN_PROC_BROWSER_TEST_F(BraveAppMenuBrowserTest, AppMenuButtonUpgradeAlertTest) {
  // Check property for our style.
  auto* brave_menu_button =
      static_cast<BraveBrowserAppMenuButton*>(menu_button());
  EXPECT_TRUE(brave_menu_button->ShouldPaintBorder());
  EXPECT_TRUE(brave_menu_button->ShouldBlendHighlightColor());

  // Check our highlight color.
  auto* theme_service =
      ThemeServiceFactory::GetForProfile(browser()->GetProfile());
  theme_service->SetBrowserColorScheme(
      ThemeService::BrowserColorScheme::kLight);
  EXPECT_EQ(brave_menu_button->GetHighlightColor(), std::nullopt);
  brave_menu_button->SetTypeAndSeverity(
      {AppMenuIconController::IconType::kUpgradeNotification,
       AppMenuIconController::Severity::kLow});
  EXPECT_EQ(brave_menu_button->GetHighlightColor(),
            SkColorSetRGB(0x00, 0x46, 0x07));
  brave_menu_button->SetTypeAndSeverity(
      {AppMenuIconController::IconType::kUpgradeNotification,
       AppMenuIconController::Severity::kMedium});
  EXPECT_EQ(brave_menu_button->GetHighlightColor(),
            SkColorSetRGB(0x4A, 0x39, 0x00));
  brave_menu_button->SetTypeAndSeverity(
      {AppMenuIconController::IconType::kUpgradeNotification,
       AppMenuIconController::Severity::kHigh});
  EXPECT_EQ(brave_menu_button->GetHighlightColor(),
            SkColorSetRGB(0x7D, 0x00, 0x1A));

  EXPECT_EQ(GetLayoutConstant(LayoutConstant::kToolbarButtonHeight),
            brave_menu_button->height());
  EXPECT_EQ(::GetLayoutInsets(TOOLBAR_BUTTON), brave_menu_button->GetInsets());
}

#if BUILDFLAG(IS_WIN)
IN_PROC_BROWSER_TEST_F(BraveAppMenuBrowserTest,
                       DeliveryHeaderTransitionsAndBrowserAlertPriority) {
  using velmren::delivery::UpdatePhase;
  velmren::delivery::UpdateStatusMonitorTestApi update;
  auto* button = menu_button();
  button->SetTypeAndSeverity({AppMenuIconController::IconType::kNone,
                              AppMenuIconController::Severity::kNone});

  update.SetPhase(UpdatePhase::kChecking);
  EXPECT_EQ(button->GetTooltipText(),
            AppMenuIconController::GetIconTooltip(
                AppMenuIconController::IconType::kNone,
                AppMenuIconController::Severity::kNone));

  update.SetPhase(UpdatePhase::kDownloading);
  EXPECT_EQ(button->GetText(),
            l10n_util::GetStringUTF16(IDS_VELMREN_UPDATE_DOWNLOADING_LABEL));
  EXPECT_NE(button->GetText(),
            l10n_util::GetStringUTF16(IDS_VELMREN_UPDATE_READY_LABEL));
  EXPECT_EQ(button->GetTooltipText(),
            l10n_util::GetStringUTF16(IDS_VELMREN_UPDATE_DOWNLOADING_TOOLTIP));
  ui::AXNodeData accessibility;
  button->GetViewAccessibility().GetAccessibleNodeData(&accessibility);
  EXPECT_EQ(accessibility.GetString16Attribute(ax::mojom::StringAttribute::kName),
            button->GetTooltipText());

  ThemeServiceFactory::GetForProfile(browser()->GetProfile())
      ->SetBrowserColorScheme(ThemeService::BrowserColorScheme::kDark);
  EXPECT_EQ(button->GetText(),
            l10n_util::GetStringUTF16(IDS_VELMREN_UPDATE_DOWNLOADING_LABEL));

  button->SetTypeAndSeverity({AppMenuIconController::IconType::kGlobalError,
                              AppMenuIconController::Severity::kHigh});
  update.SetPhase(UpdatePhase::kReady);
  EXPECT_EQ(button->GetText(),
            AppMenuIconController::GetIconLabel(
                AppMenuIconController::IconType::kGlobalError,
                AppMenuIconController::Severity::kHigh));
  EXPECT_EQ(button->GetTooltipText(),
            AppMenuIconController::GetIconTooltip(
                AppMenuIconController::IconType::kGlobalError,
                AppMenuIconController::Severity::kHigh));

  button->SetTypeAndSeverity({AppMenuIconController::IconType::kNone,
                              AppMenuIconController::Severity::kNone});
  EXPECT_EQ(button->GetText(),
            l10n_util::GetStringUTF16(IDS_VELMREN_UPDATE_READY_LABEL));
  EXPECT_EQ(button->GetTooltipText(),
            l10n_util::GetStringUTF16(IDS_VELMREN_UPDATE_READY_TOOLTIP));

  update.SetPhase(UpdatePhase::kError);
  EXPECT_EQ(button->GetTooltipText(),
            AppMenuIconController::GetIconTooltip(
                AppMenuIconController::IconType::kNone,
                AppMenuIconController::Severity::kNone));
}

IN_PROC_BROWSER_TEST_F(BraveAppMenuBrowserTest,
                       DeliveryUpdateMenuOpensAboutWithoutRestart) {
  using velmren::delivery::UpdatePhase;
  velmren::delivery::UpdateStatusMonitorTestApi update;
  auto* browser_view = BrowserView::GetBrowserViewForBrowser(browser());
  for (const auto phase : std::array{
           UpdatePhase::kUnknown, UpdatePhase::kChecking, UpdatePhase::kAvailable,
           UpdatePhase::kDownloading, UpdatePhase::kInstalling,
           UpdatePhase::kReady, UpdatePhase::kUpToDate, UpdatePhase::kError}) {
    update.SetPhase(phase);
    BraveAppMenuModel model(browser_view->toolbar(), browser());
    model.Init();
    const auto index = model.GetIndexOfCommandId(IDC_VELMREN_UPDATE_STATUS);
    ASSERT_TRUE(index.has_value());
    EXPECT_TRUE(model.IsEnabledAt(*index));
    EXPECT_EQ(model.GetLabelAt(*index),
              l10n_util::GetStringUTF16(
                  velmren::delivery::GetUpdateMenuPresentation(phase).label_id));
  }

  // ShowSingletonTabOverwritingNTP intentionally reuses about:blank. Use an
  // existing page to verify that opening About preserves the original tab.
  const GURL original_url(chrome::kChromeUIVersionURL);
  ASSERT_TRUE(ui_test_utils::NavigateToURL(browser(), original_url));
  auto* original_tab = browser()->tab_strip_model()->GetActiveWebContents();
  const int original_tab_count = browser()->tab_strip_model()->count();
  const bool restart_requested = g_browser_process->local_state()->GetBoolean(
      prefs::kRestartLastSessionOnShutdown);
  update.SetPhase(UpdatePhase::kReady);
  BraveAppMenuModel model(browser_view->toolbar(), browser());
  model.Init();
  const auto index = model.GetIndexOfCommandId(IDC_VELMREN_UPDATE_STATUS);
  ASSERT_TRUE(index.has_value());

  content::TestNavigationObserver about_navigation(/*web_contents=*/nullptr);
  about_navigation.StartWatchingNewWebContents();
  model.ActivatedAt(*index, /*event_flags=*/0);
  about_navigation.Wait();
  const auto& about_url =
      browser()->tab_strip_model()->GetActiveWebContents()->GetLastCommittedURL();
  EXPECT_EQ(about_url.host(), chrome::kChromeUISettingsHost);
  EXPECT_EQ(about_url.path(), "/help");
  EXPECT_EQ(browser()->tab_strip_model()->count(), original_tab_count + 1);
  EXPECT_EQ(browser()->tab_strip_model()->GetWebContentsAt(0), original_tab);
  EXPECT_EQ(original_tab->GetLastCommittedURL(), original_url);
  EXPECT_EQ(g_browser_process->local_state()->GetBoolean(
                prefs::kRestartLastSessionOnShutdown),
            restart_requested);
}
#endif  // BUILDFLAG(IS_WIN)

#if BUILDFLAG(ENABLE_BRAVE_VPN)
// Check toggle menu item has additional toggle button for purchased user.
IN_PROC_BROWSER_TEST_F(BraveAppMenuBrowserTest, PurchasedVPN) {
  SetPurchasedUserForBraveVPN(browser(), true);
  menu_button()->ShowMenu();
  views::MenuItemView* menu_root = menu_button()->app_menu()->root_menu_item();
  auto* toggle_menu_item = menu_root->GetMenuItemByID(IDC_TOGGLE_BRAVE_VPN);
  ASSERT_TRUE(!!toggle_menu_item);
  const int last_item_index = toggle_menu_item->children().size() - 1;
  auto* toggle_button = views::AsViewClass<views::ToggleButton>(
      toggle_menu_item->children()[last_item_index]);
  ASSERT_NE(nullptr, toggle_button);
}

// Check app menu has show vpn panel menu item for not purchased user.
IN_PROC_BROWSER_TEST_F(BraveAppMenuBrowserTest, NotPurchasedVPN) {
  SetPurchasedUserForBraveVPN(browser(), false);
  menu_button()->ShowMenu();
  views::MenuItemView* menu_root = menu_button()->app_menu()->root_menu_item();
  EXPECT_TRUE(!!menu_root->GetMenuItemByID(IDC_SHOW_BRAVE_VPN_PANEL));
}
#endif
