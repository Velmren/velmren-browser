// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#ifndef BRAVE_COMPONENTS_VELMREN_SELECTION_TRANSLATE_POLICY_H_
#define BRAVE_COMPONENTS_VELMREN_SELECTION_TRANSLATE_POLICY_H_

#include <string_view>

namespace velmren {

struct SelectionTranslateAvailability {
  bool feature_enabled = false;
  bool document_supported = false;
  bool online = false;
  bool policy_allowed = false;
  bool password_field = false;
  bool target_supported = false;
};

// Manual selection translation does not depend on the document's language,
// fluent-language preferences, or the default search provider.
bool CanTranslateSelection(std::u16string_view text,
                           const SelectionTranslateAvailability& availability);

}  // namespace velmren

#endif  // BRAVE_COMPONENTS_VELMREN_SELECTION_TRANSLATE_POLICY_H_
