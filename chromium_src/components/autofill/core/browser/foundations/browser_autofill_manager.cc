/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "build/build_config.h"
#include "components/autofill/core/browser/integrators/password_manager/password_manager_delegate.h"

#if BUILDFLAG(IS_WIN)
#define BRAVE_BROWSER_AUTOFILL_MANAGER_SHOW_PASSWORD_SUGGESTIONS \
  password_delegate->ShowSuggestionsWithFormData(*password_request)
#else
#define BRAVE_BROWSER_AUTOFILL_MANAGER_SHOW_PASSWORD_SUGGESTIONS \
  password_delegate->ShowSuggestions(password_request->field)
#endif

#include <components/autofill/core/browser/foundations/browser_autofill_manager.cc>

#undef BRAVE_BROWSER_AUTOFILL_MANAGER_SHOW_PASSWORD_SUGGESTIONS

#if BUILDFLAG(IS_WIN)
namespace autofill {

void PasswordManagerDelegate::ShowSuggestionsWithFormData(
    const PasswordSuggestionRequest& request) {
  ShowSuggestions(request.field);
}

}  // namespace autofill
#endif  // BUILDFLAG(IS_WIN)
