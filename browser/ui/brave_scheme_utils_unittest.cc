// Copyright (c) 2024 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/browser/ui/brave_scheme_utils.h"

#include "testing/gtest/include/gtest/gtest.h"

TEST(BraveSchemeUtilsTest, ReplaceChromeToBraveScheme) {
  constexpr const char16_t* kAliases[] = {
      u"chrome://settings/appearance?foo=bar#section",
      u"brave://settings/appearance?foo=bar#section",
      u"CHROME://settings/appearance?foo=bar#section",
      u"BrAvE://settings/appearance?foo=bar#section"};
  for (const char16_t* alias : kAliases) {
    std::u16string url_string(alias);
    EXPECT_TRUE(brave_utils::ReplaceChromeToBraveScheme(url_string));
    EXPECT_EQ(url_string, u"velmren://settings/appearance?foo=bar#section");
  }
}

TEST(BraveSchemeUtilsTest, OtherSchemesRemainUnchanged) {
  constexpr const char16_t* kURLs[] = {
      u"velmren://settings",
      u"https://search.brave.com",
      u"https://example.com/?next=brave://settings",
      u"chrome-extension://id/page.html",
      u"chrome-untrusted://new-tab-page/",
      u"brave-search://query"};
  for (const char16_t* url : kURLs) {
    std::u16string url_string(url);
    EXPECT_FALSE(brave_utils::ReplaceChromeToBraveScheme(url_string));
    EXPECT_EQ(url_string, url);
  }
}
