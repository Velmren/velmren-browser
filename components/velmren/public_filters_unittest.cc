// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/components/velmren/public_filters.h"

#include "testing/gtest/include/gtest/gtest.h"

namespace velmren {

TEST(VelmrenPublicFiltersTest, TrustedUrlsAreExact) {
  const auto* list =
      FindPublicFilterList("https://easylist.to/easylist/easylist.txt");
  ASSERT_TRUE(list);
  EXPECT_TRUE(list->is_default_engine);
  EXPECT_EQ(list->permission_mask, 1);
  EXPECT_FALSE(FindPublicFilterList(
      "https://easylist.to.evil.invalid/easylist/easylist.txt"));
  EXPECT_FALSE(FindPublicFilterList(
      "http://easylist.to/easylist/easylist.txt"));
  const auto* first_party = FindPublicFilterList(
      "https://raw.githubusercontent.com/brave/adblock-lists/master/"
      "brave-lists/brave-firstparty.txt");
  ASSERT_TRUE(first_party);
  EXPECT_FALSE(first_party->is_default_engine);
}

TEST(VelmrenPublicFiltersTest, NestedElseCannotEscapeDisabledParent) {
  const auto result = PreprocessPublicFilters(
      "always\n!#if env_firefox\nhidden\n!#if env_chromium\n"
      "nested\n!#else\nalso-hidden\n!#endif\n!#else\nvisible\n!#endif");
  ASSERT_TRUE(result);
  EXPECT_EQ(*result, "always\nvisible\n");
}

TEST(VelmrenPublicFiltersTest, NegationAndUnknownConditionsMatchUpstream) {
  const auto result = PreprocessPublicFilters(
      "!#if !env_firefox\nvisible\n!#else\nhidden\n!#endif\n"
      "!#if future_capability\nfirst\n!#else\nsecond\n!#endif");
  ASSERT_TRUE(result);
  EXPECT_EQ(*result, "visible\nfirst\nsecond\n");
}

TEST(VelmrenPublicFiltersTest, RejectMalformedConditionals) {
  EXPECT_FALSE(PreprocessPublicFilters("!#else\nrule"));
  EXPECT_FALSE(PreprocessPublicFilters("!#if env_chromium\nrule"));
  EXPECT_FALSE(PreprocessPublicFilters("!#endif"));
  EXPECT_FALSE(PreprocessPublicFilters(
      "!#if env_chromium\n!#else\n!#else\n!#endif"));
}

}  // namespace velmren
