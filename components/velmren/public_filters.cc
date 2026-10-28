// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/components/velmren/public_filters.h"

#include <algorithm>
#include <array>
#include <utility>
#include <vector>

#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "brave/components/velmren/resources/grit/velmren_filter_resources.h"

namespace velmren {
namespace {

// Generated from the pinned upstream catalog; see resources/PROVENANCE.json.
#include "brave/components/velmren/public_filter_list_entries.inc"

std::optional<bool> EvaluateCondition(std::string_view expression) {
  bool negate = expression.starts_with('!');
  if (negate) {
    expression.remove_prefix(1);
  }
  constexpr auto kTrueConditions = std::to_array<std::string_view>({
      "ext_ublock", "env_chromium", "cap_user_stylesheet",
      "adguard_ext_chromium", "adguard_ext_opera"});
  constexpr auto kFalseConditions = std::to_array<std::string_view>({
      "ext_devbuild", "env_devbuild", "env_edge", "env_firefox", "env_legacy",
      "env_safari", "cap_html_filtering", "false", "ext_abp", "adguard",
      "adguard_app_android", "adguard_app_ios", "adguard_app_mac",
      "adguard_app_windows", "adguard_ext_android_cb", "adguard_ext_edge",
      "adguard_ext_firefox", "adguard_ext_safari"});
  if (std::ranges::contains(kTrueConditions, expression)) {
    return !negate;
  }
  if (std::ranges::contains(kFalseConditions, expression)) {
    return negate;
  }
  // Upstream retains both branches of unknown conditions.
  return std::nullopt;
}

}  // namespace

std::span<const PublicFilterList> GetPublicFilterLists() {
  return kPublicFilterLists;
}

const PublicFilterList* FindPublicFilterList(std::string_view url) {
  for (const auto& list : kPublicFilterLists) {
    if (list.url == url) {
      return &list;
    }
  }
  return nullptr;
}

std::optional<std::string> PreprocessPublicFilters(std::string_view input) {
  struct Branch {
    bool parent_active;
    std::optional<bool> condition;
    bool seen_else = false;
  };
  std::vector<Branch> stack;
  bool active = true;
  std::string output;
  for (std::string_view line : base::SplitStringPiece(
           input, "\n", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL)) {
    const auto directive = base::TrimWhitespaceASCII(line, base::TRIM_ALL);
    if (directive.starts_with("!#if ")) {
      const auto condition = EvaluateCondition(directive.substr(5));
      stack.push_back({active, condition});
      active = active && condition.value_or(true);
    } else if (directive == "!#else") {
      if (stack.empty() || stack.back().seen_else) {
        return std::nullopt;
      }
      auto& branch = stack.back();
      branch.seen_else = true;
      active = branch.parent_active &&
               (!branch.condition.has_value() || !*branch.condition);
    } else if (directive == "!#endif") {
      if (stack.empty()) {
        return std::nullopt;
      }
      active = stack.back().parent_active;
      stack.pop_back();
    } else if (active) {
      output.append(line);
      output.push_back('\n');
    }
  }
  return stack.empty() ? std::make_optional(std::move(output)) : std::nullopt;
}

}  // namespace velmren
