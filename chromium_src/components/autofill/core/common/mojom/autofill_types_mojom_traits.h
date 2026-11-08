/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CORE_COMMON_MOJOM_AUTOFILL_TYPES_MOJOM_TRAITS_H_
#define BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CORE_COMMON_MOJOM_AUTOFILL_TYPES_MOJOM_TRAITS_H_

#include <optional>
#include <string>

#define BRAVE_PASSWORD_SUGGESTION_REQUEST_SELECTED_USERNAME_TRAITS \
  static const std::optional<std::u16string>& selected_username(   \
      const autofill::PasswordSuggestionRequest& request) {        \
    return request.selected_username;                              \
  }

#include <components/autofill/core/common/mojom/autofill_types_mojom_traits.h>  // IWYU pragma: export

#undef BRAVE_PASSWORD_SUGGESTION_REQUEST_SELECTED_USERNAME_TRAITS

#endif  // BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CORE_COMMON_MOJOM_AUTOFILL_TYPES_MOJOM_TRAITS_H_
