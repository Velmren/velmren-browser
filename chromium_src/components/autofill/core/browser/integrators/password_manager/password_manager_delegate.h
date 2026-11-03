/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CORE_BROWSER_INTEGRATORS_PASSWORD_MANAGER_PASSWORD_MANAGER_DELEGATE_H_
#define BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CORE_BROWSER_INTEGRATORS_PASSWORD_MANAGER_PASSWORD_MANAGER_DELEGATE_H_

#include "build/build_config.h"

#if BUILDFLAG(IS_WIN)
// Desktop already receives the form with each request. Keep that context for
// password ranking while retaining the field-only interface for other callers.
#define BRAVE_PASSWORD_MANAGER_DELEGATE_SHOW_SUGGESTIONS \
  virtual void ShowSuggestionsWithFormData(              \
      const PasswordSuggestionRequest& request);
#else
#define BRAVE_PASSWORD_MANAGER_DELEGATE_SHOW_SUGGESTIONS
#endif

#include <components/autofill/core/browser/integrators/password_manager/password_manager_delegate.h>  // IWYU pragma: export

#undef BRAVE_PASSWORD_MANAGER_DELEGATE_SHOW_SUGGESTIONS

#endif  // BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CORE_BROWSER_INTEGRATORS_PASSWORD_MANAGER_PASSWORD_MANAGER_DELEGATE_H_
