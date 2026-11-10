// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/components/velmren/selection_translate_policy.h"

#include <string>

#include "testing/gtest/include/gtest/gtest.h"

namespace velmren {
namespace {

SelectionTranslateAvailability Available() {
  return {.feature_enabled = true,
          .document_supported = true,
          .online = true,
          .policy_allowed = true,
          .target_supported = true};
}

TEST(SelectionTranslatePolicyTest,
     ForeignSelectionNeedsNoPageLanguageOrSearch) {
  EXPECT_TRUE(CanTranslateSelection(u"Please send the document.", Available()));
  EXPECT_TRUE(CanTranslateSelection(u"Bonjour le monde", Available()));
  EXPECT_TRUE(CanTranslateSelection(u"Привет, мир", Available()));
}

TEST(SelectionTranslatePolicyTest, PasswordSelectionIsNeverOffered) {
  auto availability = Available();
  availability.password_field = true;
  EXPECT_FALSE(CanTranslateSelection(u"secret", availability));
}

TEST(SelectionTranslatePolicyTest, EmptyOrUnicodeWhitespaceIsNotASelection) {
  EXPECT_FALSE(CanTranslateSelection(u"", Available()));
  EXPECT_FALSE(CanTranslateSelection(u" \t\n\r\u00a0\u2003", Available()));
  EXPECT_TRUE(CanTranslateSelection(u" \nHello\u00a0", Available()));
}

TEST(SelectionTranslatePolicyTest, ManagedPolicyAndFeatureAreRespected) {
  auto availability = Available();
  availability.policy_allowed = false;
  EXPECT_FALSE(CanTranslateSelection(u"Hello", availability));
  availability = Available();
  availability.feature_enabled = false;
  EXPECT_FALSE(CanTranslateSelection(u"Hello", availability));
}

TEST(SelectionTranslatePolicyTest, UnsupportedDocumentsAndTargetsAreExcluded) {
  auto availability = Available();
  availability.document_supported = false;
  EXPECT_FALSE(CanTranslateSelection(u"Hello", availability));
  availability = Available();
  availability.target_supported = false;
  EXPECT_FALSE(CanTranslateSelection(u"Hello", availability));
}

TEST(SelectionTranslatePolicyTest, OfflineRequestsAreNotOffered) {
  auto availability = Available();
  availability.online = false;
  EXPECT_FALSE(CanTranslateSelection(u"Hello", availability));
}

TEST(SelectionTranslatePolicyTest, LongSelectionCanUseTheBubblesTruncation) {
  EXPECT_TRUE(CanTranslateSelection(std::u16string(20000, u'x'), Available()));
}

}  // namespace
}  // namespace velmren
