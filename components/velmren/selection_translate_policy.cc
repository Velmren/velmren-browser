// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/components/velmren/selection_translate_policy.h"

#include "base/strings/string_util.h"

namespace velmren {

bool CanTranslateSelection(std::u16string_view text,
                           const SelectionTranslateAvailability& availability) {
  return availability.feature_enabled && availability.document_supported &&
         availability.online && availability.policy_allowed &&
         !availability.password_field && availability.target_supported &&
         !base::TrimWhitespace(text, base::TRIM_ALL).empty();
}

}  // namespace velmren
