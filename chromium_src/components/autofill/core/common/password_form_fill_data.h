/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CORE_COMMON_PASSWORD_FORM_FILL_DATA_H_
#define BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CORE_COMMON_PASSWORD_FORM_FILL_DATA_H_

#include <optional>
#include <string>

// Ranking hint captured with this request, never an autofill instruction.
// nullopt means no current-page signal; empty means ambiguous or empty signal.
#define BRAVE_PASSWORD_SUGGESTION_REQUEST_SELECTED_USERNAME \
  std::optional<std::u16string> selected_username;

#include <components/autofill/core/common/password_form_fill_data.h>  // IWYU pragma: export

#undef BRAVE_PASSWORD_SUGGESTION_REQUEST_SELECTED_USERNAME

#endif  // BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CORE_COMMON_PASSWORD_FORM_FILL_DATA_H_
