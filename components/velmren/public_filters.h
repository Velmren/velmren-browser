// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#ifndef BRAVE_COMPONENTS_VELMREN_PUBLIC_FILTERS_H_
#define BRAVE_COMPONENTS_VELMREN_PUBLIC_FILTERS_H_

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace velmren {

struct PublicFilterList {
  std::string_view url;
  std::string_view title;
  bool is_default_engine;
  uint8_t permission_mask;
  int resource_id;
};

std::span<const PublicFilterList> GetPublicFilterLists();
const PublicFilterList* FindPublicFilterList(std::string_view url);

// Matches the desktop conditions used by Brave's public CRX packager.
// A malformed conditional rejects the list instead of selecting wrong rules.
std::optional<std::string> PreprocessPublicFilters(std::string_view input);

}  // namespace velmren

#endif  // BRAVE_COMPONENTS_VELMREN_PUBLIC_FILTERS_H_
