/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "chrome/browser/ui/tabs/tab_data.h"

#include <memory>

#include "base/command_line.h"
#include "base/containers/span.h"
#include "base/files/file_util.h"
#include "base/memory/ref_counted_memory.h"
#include "base/threading/thread_restrictions.h"
#include "brave/components/vector_icons/vector_icons.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "chrome/browser/ui/color/chrome_color_id.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/webui/new_tab_page/new_tab_page_ui.h"
#include "chrome/common/webui_url_constants.h"
#include "chrome/grit/theme_resources.h"
#include "chrome/test/base/in_process_browser_test.h"
#include "chrome/test/base/ui_test_utils.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"
#include "content/public/test/browser_test.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/base/models/image_model.h"
#include "ui/base/resource/resource_bundle.h"
#include "ui/color/color_provider.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/favicon_size.h"
#include "ui/gfx/image/image_skia.h"
#include "url/gurl.h"

namespace tabs {

class BraveTabDataBrowserTest : public InProcessBrowserTest {
 protected:
  void CheckNewTabFavicon(ThemeService::BrowserColorScheme scheme) {
    ThemeServiceFactory::GetForProfile(browser()->GetProfile())
        ->SetBrowserColorScheme(scheme);
    ASSERT_TRUE(ui_test_utils::NavigateToURLWithDisposition(
        browser(), GURL(chrome::kChromeUINewTabURL),
        WindowOpenDisposition::CURRENT_TAB,
        ui_test_utils::BROWSER_TEST_WAIT_FOR_LOAD_STOP));

    TabInterface* const tab_interface =
        browser()->GetTabStripModel()->GetTabAtIndex(0);
    auto tab_data_observer = std::make_unique<TabDataObserver>(tab_interface);
    const TabData& data = tab_data_observer->tab_data();
    const auto& colors = tab_interface->GetContents()->GetColorProvider();

    EXPECT_FALSE(data.should_themify_favicon);
    ASSERT_TRUE(data.favicon.IsVectorIcon());
    EXPECT_EQ(data.favicon.GetVectorIcon().vector_icon(),
              &kLeoBraveIconOnlyFaceIcon);
    EXPECT_EQ(data.favicon.GetVectorIcon().icon_size(), gfx::kFaviconSize);
    EXPECT_EQ(data.favicon,
              ui::ImageModel::FromVectorIcon(
                  kLeoBraveIconOnlyFaceIcon,
                  colors.GetColor(kColorTabForegroundActiveFrameActive),
                  gfx::kFaviconSize));

    const auto raster = data.favicon.Rasterize(&colors);
    ASSERT_FALSE(raster.isNull());
    EXPECT_EQ(raster.width(), gfx::kFaviconSize);
    EXPECT_EQ(raster.height(), gfx::kFaviconSize);
    const auto output_dir = base::CommandLine::ForCurrentProcess()
                                ->GetSwitchValuePath("velmren-favicon-output-dir");
    if (!output_dir.empty()) {
      base::ScopedAllowBlockingForTesting allow_blocking;
      const auto png = gfx::PNGCodec::EncodeBGRASkBitmap(*raster.bitmap(), false);
      ASSERT_TRUE(png);
      ASSERT_TRUE(base::CreateDirectory(output_dir));
      ASSERT_TRUE(base::WriteFile(
          output_dir.AppendASCII(scheme == ThemeService::BrowserColorScheme::kDark
                                     ? "ntp-favicon-dark.png"
                                     : "ntp-favicon-light.png"),
          *png));
    }
  }
};

// Exercise the model used by the native tab strip, not the NTP page's DOM icon.
IN_PROC_BROWSER_TEST_F(BraveTabDataBrowserTest, NTPFaviconLightTheme) {
  CheckNewTabFavicon(ThemeService::BrowserColorScheme::kLight);
}

IN_PROC_BROWSER_TEST_F(BraveTabDataBrowserTest, NTPFaviconDarkTheme) {
  CheckNewTabFavicon(ThemeService::BrowserColorScheme::kDark);
}

IN_PROC_BROWSER_TEST_F(BraveTabDataBrowserTest, NTPSharedFaviconUsesProductArtwork) {
  auto& resources = ui::ResourceBundle::GetSharedInstance();
  for (const auto scale : {ui::k100Percent, ui::k200Percent}) {
    const auto favicon = NewTabPageUI::GetFaviconResourceBytes(scale);
    const auto product =
        resources.LoadDataResourceBytesForScale(IDR_PRODUCT_LOGO_16, scale);
    ASSERT_TRUE(favicon);
    ASSERT_TRUE(product);
    EXPECT_EQ(base::span(*favicon), base::span(*product));
  }
}

}  // namespace tabs
