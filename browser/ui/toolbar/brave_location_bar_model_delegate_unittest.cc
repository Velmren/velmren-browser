/* Copyright (c) 2019 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/toolbar/brave_location_bar_model_delegate.h"

#include "base/strings/utf_string_conversions.h"
#include "extensions/buildflags/buildflags.h"
#include "testing/gtest/include/gtest/gtest.h"

using BraveLocationBarModelDelegateTest = testing::Test;

TEST_F(BraveLocationBarModelDelegateTest, ResolvesInternalSchemeToVelmren) {
  constexpr const char* kURLs[] = {"chrome://sync/", "brave://sync/",
                                   "velmren://sync/"};
  for (const char* url_string : kURLs) {
    SCOPED_TRACE(url_string);
    GURL url(url_string);
    std::u16string formatted_url = base::UTF8ToUTF16(url.spec());
    BraveLocationBarModelDelegate::FormattedStringFromURL(url, &formatted_url);
    EXPECT_EQ(formatted_url, u"velmren://sync/");
  }
}
