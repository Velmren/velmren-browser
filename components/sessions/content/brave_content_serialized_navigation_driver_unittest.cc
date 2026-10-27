/* Copyright (c) 2022 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "components/sessions/content/content_serialized_navigation_driver.h"
#include "components/sessions/core/serialized_navigation_entry.h"
#include "components/sessions/core/serialized_navigation_entry_test_helper.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace sessions {

// Tests that PageState data is properly sanitized when post data is present.
TEST(BraveContentSerializedNavigationDriverTest,
     PickleSanitizationWithPostDataForChromePages) {
  ContentSerializedNavigationDriver* driver =
      ContentSerializedNavigationDriver::GetInstance();
  SerializedNavigationEntry navigation =
      SerializedNavigationEntryTestHelper::CreateNavigationForTest();
  ASSERT_TRUE(navigation.has_post_data());

  // When post data is present, the page state should be sanitized.
  EXPECT_EQ(std::string(), driver->GetSanitizedPageStateForPickle(&navigation));

  // Check encoded data is empty for a chrome:// url overridable by extension.
  navigation.set_virtual_url(GURL("chrome://newtab"));
  EXPECT_EQ(std::string(), driver->GetSanitizedPageStateForPickle(&navigation));

  // Check encoded data is empty.
  navigation.set_virtual_url(GURL("chrome://wallet"));
  EXPECT_EQ(std::string(), driver->GetSanitizedPageStateForPickle(&navigation));
}

// Tests that PageState data is left unsanitized when post data is absent.
TEST(BraveContentSerializedNavigationDriverTest,
     PickleSanitizationNoPostDataForChromePages) {
  ContentSerializedNavigationDriver* driver =
      ContentSerializedNavigationDriver::GetInstance();
  SerializedNavigationEntry navigation =
      SerializedNavigationEntryTestHelper::CreateNavigationForTest();
  SerializedNavigationEntryTestHelper::SetHasPostData(false, &navigation);
  ASSERT_FALSE(navigation.has_post_data());
  EXPECT_EQ(test_data::kEncodedPageState,
            driver->GetSanitizedPageStateForPickle(&navigation));

  // Check encoded data is empty for a chrome:// url overridable by extension.
  navigation.set_virtual_url(GURL("chrome://newtab"));
  EXPECT_EQ(std::string(), driver->GetSanitizedPageStateForPickle(&navigation));

  // Check encoded data is empty.
  navigation.set_virtual_url(GURL("chrome://wallet"));
  EXPECT_EQ(std::string(), driver->GetSanitizedPageStateForPickle(&navigation));
}

// Restored UI aliases retain the same internal origin and URL suffix.
TEST(BraveContentSerializedNavigationDriverTest,
     SanitizeConvertsUIAliasesToChrome) {
  ContentSerializedNavigationDriver* driver =
      ContentSerializedNavigationDriver::GetInstance();
  SerializedNavigationEntry navigation =
      SerializedNavigationEntryTestHelper::CreateNavigationForTest();

  constexpr const char* kURLs[] = {"chrome://flags/?foo=bar#feature",
                                   "brave://flags/?foo=bar#feature",
                                   "velmren://flags/?foo=bar#feature"};
  for (const char* url : kURLs) {
    SCOPED_TRACE(url);
    navigation.set_virtual_url(GURL(url));
    driver->Sanitize(&navigation);
    EXPECT_EQ(GURL("chrome://flags/?foo=bar#feature"),
              navigation.virtual_url());
    EXPECT_EQ(std::string(),
              driver->GetSanitizedPageStateForPickle(&navigation));
  }
}

TEST(BraveContentSerializedNavigationDriverTest,
     SanitizePreservesOtherSchemes) {
  auto* driver = ContentSerializedNavigationDriver::GetInstance();
  auto navigation =
      SerializedNavigationEntryTestHelper::CreateNavigationForTest();
  constexpr const char* kURLs[] = {"https://example.com/?url=brave://flags",
                                   "chrome-untrusted://new-tab-page/",
                                   "chrome-extension://id/page.html"};
  for (const char* url : kURLs) {
    SCOPED_TRACE(url);
    navigation.set_virtual_url(GURL(url));
    driver->Sanitize(&navigation);
    EXPECT_EQ(GURL(url), navigation.virtual_url());
  }
}

}  // namespace sessions
