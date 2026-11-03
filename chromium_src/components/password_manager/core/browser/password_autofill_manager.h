/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_COMPONENTS_PASSWORD_MANAGER_CORE_BROWSER_PASSWORD_AUTOFILL_MANAGER_H_
#define BRAVE_CHROMIUM_SRC_COMPONENTS_PASSWORD_MANAGER_CORE_BROWSER_PASSWORD_AUTOFILL_MANAGER_H_

#include <optional>
#include <string>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "build/build_config.h"
#include "components/autofill/core/browser/integrators/password_manager/password_manager_delegate.h"
#include "components/autofill/core/browser/suggestions/suggestion.h"
#include "components/autofill/core/common/password_form_fill_data.h"
#include "components/autofill/core/common/unique_ids.h"
#include "url/origin.h"

#if BUILDFLAG(IS_WIN)
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_PUBLIC \
  void ShowSuggestionsWithFormData(            \
      const autofill::PasswordSuggestionRequest& request) override;

#define BRAVE_PASSWORD_AUTOFILL_MANAGER_PRIVATE                         \
  struct SelectedAccountContext {                                       \
    autofill::FormGlobalId form_id;                                     \
    autofill::FieldGlobalId password_field_id;                          \
    autofill::FieldGlobalId username_field_id;                          \
    url::Origin origin;                                                 \
    std::u16string username;                                            \
  };                                                                    \
  std::optional<SelectedAccountContext> selected_account_context_;      \
  bool processing_selected_account_request_ = false;                    \
  bool generating_selected_account_suggestions_ = false;                \
  void ResetSelectedAccountContext();                                   \
  bool HasSelectedAccountContext(                                       \
      const autofill::PasswordFormFillData& fill_data) const;           \
  base::WeakPtr<PasswordAutofillManager> GetSuggestionRequestWeakPtr(); \
  std::vector<autofill::Suggestion> GetSuggestions_ChromiumImpl(        \
      const std::u16string& username_filter,                            \
      OffersGeneration offers_generation,                               \
      ShowPasswordSuggestions show_password_suggestions,                \
      ShowWebAuthnCredentials show_webauthn_credentials,                \
      ShowIdentityCredentials show_identity_credentials);               \
  base::WeakPtrFactory<PasswordAutofillManager>                         \
      suggestion_request_weak_ptr_factory_{this};
#else
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_PUBLIC
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_PRIVATE
#endif

#include <components/password_manager/core/browser/password_autofill_manager.h>  // IWYU pragma: export

#undef BRAVE_PASSWORD_AUTOFILL_MANAGER_PRIVATE
#undef BRAVE_PASSWORD_AUTOFILL_MANAGER_PUBLIC

#endif  // BRAVE_CHROMIUM_SRC_COMPONENTS_PASSWORD_MANAGER_CORE_BROWSER_PASSWORD_AUTOFILL_MANAGER_H_
