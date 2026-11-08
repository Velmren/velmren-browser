/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "components/password_manager/core/browser/password_autofill_manager.h"

#include <algorithm>
#include <string>
#include <variant>
#include <vector>

#include "base/auto_reset.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "build/build_config.h"
#include "components/autofill/core/browser/foundations/autofill_driver.h"
#include "components/autofill/core/common/form_field_data.h"
#include "components/password_manager/core/browser/password_manager_driver.h"
#include "components/password_manager/core/browser/password_manager_interface.h"
#include "components/password_manager/core/common/password_manager_constants.h"
#include "url/origin.h"

#if BUILDFLAG(IS_WIN)
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_RESET_SELECTED_ACCOUNT \
  ResetSelectedAccountContext();
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_SHOW_SUGGESTIONS \
  if (!processing_selected_account_request_) {           \
    ResetSelectedAccountContext();                       \
  }
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_ON_ADD_PASSWORD_FILL_DATA           \
  if (selected_account_context_ && !HasSelectedAccountContext(fill_data)) { \
    ResetSelectedAccountContext();                                          \
  }                                                                         \
  base::AutoReset<bool> selected_account_generation_scope(                  \
      &generating_selected_account_suggestions_,                            \
      selected_account_context_ &&                                          \
          selected_account_context_->password_field_id == last_field_id_);
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_CONTINUE_SHOWING_SUGGESTIONS       \
  if (selected_account_context_ &&                                         \
      (selected_account_context_->password_field_id != field.element_id || \
       (fill_data_ && !HasSelectedAccountContext(*fill_data_)))) {         \
    ResetSelectedAccountContext();                                         \
  }                                                                        \
  base::AutoReset<bool> selected_account_generation_scope(                 \
      &generating_selected_account_suggestions_,                           \
      selected_account_context_ && fill_data_ &&                           \
          HasSelectedAccountContext(*fill_data_));
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_SUGGESTION_WEAK_PTR \
  GetSuggestionRequestWeakPtr()
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_GET_SUGGESTIONS \
  GetSuggestions_ChromiumImpl
#else
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_RESET_SELECTED_ACCOUNT
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_SHOW_SUGGESTIONS
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_ON_ADD_PASSWORD_FILL_DATA
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_CONTINUE_SHOWING_SUGGESTIONS
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_SUGGESTION_WEAK_PTR GetWeakPtr()
#define BRAVE_PASSWORD_AUTOFILL_MANAGER_GET_SUGGESTIONS GetSuggestions
#endif

#include <components/password_manager/core/browser/password_autofill_manager.cc>

#undef BRAVE_PASSWORD_AUTOFILL_MANAGER_GET_SUGGESTIONS
#undef BRAVE_PASSWORD_AUTOFILL_MANAGER_SUGGESTION_WEAK_PTR
#undef BRAVE_PASSWORD_AUTOFILL_MANAGER_CONTINUE_SHOWING_SUGGESTIONS
#undef BRAVE_PASSWORD_AUTOFILL_MANAGER_ON_ADD_PASSWORD_FILL_DATA
#undef BRAVE_PASSWORD_AUTOFILL_MANAGER_SHOW_SUGGESTIONS
#undef BRAVE_PASSWORD_AUTOFILL_MANAGER_RESET_SELECTED_ACCOUNT

#if BUILDFLAG(IS_WIN)
namespace password_manager {
namespace {

bool IsUsernameInput(const autofill::FormFieldData& field) {
  return field.form_control_type() == autofill::FormControlType::kInputText ||
         field.form_control_type() == autofill::FormControlType::kInputEmail;
}

bool HasExplicitUsernameAutocomplete(const autofill::FormFieldData& field) {
  // Use the password form parser's final-token rule, including optional
  // WebAuthn.
  auto tokens = base::SplitStringPiece(
      field.autocomplete_attribute(), base::kWhitespaceASCII,
      base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
  if (!tokens.empty() && base::EqualsCaseInsensitiveASCII(
                             tokens.back(), constants::kAutocompleteWebAuthn)) {
    tokens.pop_back();
  }
  return !tokens.empty() &&
         base::EqualsCaseInsensitiveASCII(tokens.back(),
                                          constants::kAutocompleteUsername);
}

bool IsCurrentPasswordSuggestionRequest(
    const autofill::PasswordSuggestionRequest& request,
    const PasswordManagerDriver& password_driver) {
  const autofill::AutofillDriver* autofill_driver =
      password_driver.GetAutofillDriver();
  const auto& form = request.form_data;
  const auto* password_field =
      form.FindFieldByGlobalId(request.field.element_id);
  const url::Origin origin = url::Origin::Create(form.url());
  if (!autofill_driver || origin.opaque() ||
      form.host_frame() != autofill_driver->GetFrameToken() ||
      origin != password_driver.GetLastCommittedOrigin() || !password_field ||
      password_field->origin() != origin ||
      !password_field->IsPasswordInputElement() ||
      password_field->renderer_form_id() != form.global_id() ||
      request.password_field_id != password_field->global_id()) {
    return false;
  }
  return true;
}

const autofill::FormFieldData* SelectedUsernameFieldFromRequest(
    const autofill::PasswordSuggestionRequest& request,
    bool& has_username_signal) {
  const auto& form = request.form_data;
  const auto origin = url::Origin::Create(form.url());
  const auto is_current_username = [&](const autofill::FormFieldData& field) {
    return field.renderer_form_id() == form.global_id() &&
           field.origin() == origin && IsUsernameInput(field);
  };
  if (request.username_field_id.renderer_id) {
    has_username_signal = true;
    const auto* username_field =
        form.FindFieldByGlobalId(request.username_field_id);
    return username_field && is_current_username(*username_field)
               ? username_field
               : nullptr;
  }

  // A password-only step can retain a CSS-hidden username input that the
  // renderer did not associate with the password. Accept only its explicit,
  // unambiguous autocomplete role in this same renderer form.
  const autofill::FormFieldData* username_field = nullptr;
  for (const auto& field : form.fields()) {
    if (!is_current_username(field)) {
      continue;
    }
    if (!HasExplicitUsernameAutocomplete(field)) {
      continue;
    }
    has_username_signal = true;
    if (username_field) {
      return nullptr;
    }
    username_field = &field;
  }
  return username_field;
}

bool IsPasswordSuggestion(const autofill::Suggestion& suggestion) {
  return suggestion.type == autofill::SuggestionType::kPasswordEntry ||
         suggestion.type ==
             autofill::SuggestionType::kAccountStoragePasswordEntry;
}

bool IsPasswordOrBackupSuggestion(const autofill::Suggestion& suggestion) {
  return IsPasswordSuggestion(suggestion) ||
         suggestion.type == autofill::SuggestionType::kBackupPasswordEntry;
}

bool SuggestionMatchesSelectedUsername(const autofill::Suggestion& suggestion,
                                       const std::u16string& username) {
  if (IsPasswordSuggestion(suggestion)) {
    // Non-primary text is the localized replacement for an empty username.
    return suggestion.main_text.is_primary &&
           suggestion.main_text.value == username;
  }
  if (suggestion.type == autofill::SuggestionType::kBackupPasswordEntry) {
    const auto* credential =
        std::get_if<autofill::Suggestion::PasswordSuggestionDetails>(
            &suggestion.payload);
    return credential && credential->username == username;
  }
  return false;
}

}  // namespace

void PasswordAutofillManager::ShowSuggestionsWithFormData(
    const autofill::PasswordSuggestionRequest& request) {
  ResetSelectedAccountContext();
  if (IsCurrentPasswordSuggestionRequest(request, *password_manager_driver_)) {
    bool has_username_signal = false;
    const auto* username_field =
        SelectedUsernameFieldFromRequest(request, has_username_signal);
    std::optional<std::u16string> username;
    if (has_username_signal) {
      if (username_field) {
        username = username_field->value();
      }
      // A changed/empty/ambiguous current identity must never fall back to the
      // previous step, even when that previous account has a saved credential.
      if (request.selected_username &&
          (!username || *username != *request.selected_username)) {
        username = std::u16string();
      }
    } else if (request.selected_username) {
      username = request.selected_username;
    } else if (const auto* password_manager =
                   password_manager_driver_->GetPasswordManager()) {
      username = password_manager->GetRecentUsernameForSuggestions(
          *password_manager_driver_, request.form_data);
    }
    if (username && !username->empty() && username->size() <= 1024) {
      selected_account_context_ = SelectedAccountContext{
          request.form_data.global_id(), request.password_field_id,
          username_field ? username_field->global_id()
                         : autofill::FieldGlobalId(),
          url::Origin::Create(request.form_data.url()), std::move(*username)};
    }
  }
  base::AutoReset<bool> request_scope(&processing_selected_account_request_,
                                      true);
  ShowSuggestions(request.field);
}

void PasswordAutofillManager::ResetSelectedAccountContext() {
  selected_account_context_.reset();
  suggestion_request_weak_ptr_factory_.InvalidateWeakPtrs();
  wait_for_passkeys_timer_.Stop();
}

bool PasswordAutofillManager::HasSelectedAccountContext(
    const autofill::PasswordFormFillData& fill_data) const {
  const autofill::AutofillDriver* autofill_driver =
      password_manager_driver_->GetAutofillDriver();
  return selected_account_context_ && autofill_driver &&
         selected_account_context_->form_id.frame_token ==
             autofill_driver->GetFrameToken() &&
         selected_account_context_->origin ==
             password_manager_driver_->GetLastCommittedOrigin() &&
         selected_account_context_->origin ==
             url::Origin::Create(fill_data.url) &&
         selected_account_context_->form_id.renderer_id ==
             fill_data.form_renderer_id &&
         selected_account_context_->password_field_id.renderer_id ==
             fill_data.password_element_renderer_id &&
         (!selected_account_context_->username_field_id.renderer_id ||
          !std::ranges::contains(
              fill_data.suggestion_banned_fields,
              selected_account_context_->username_field_id.renderer_id));
}

base::WeakPtr<PasswordAutofillManager>
PasswordAutofillManager::GetSuggestionRequestWeakPtr() {
  return suggestion_request_weak_ptr_factory_.GetWeakPtr();
}

std::vector<autofill::Suggestion> PasswordAutofillManager::GetSuggestions(
    const std::u16string& username_filter,
    OffersGeneration offers_generation,
    ShowPasswordSuggestions show_password_suggestions,
    ShowWebAuthnCredentials show_webauthn_credentials,
    ShowIdentityCredentials show_identity_credentials) {
  auto suggestions = GetSuggestions_ChromiumImpl(
      username_filter, offers_generation, show_password_suggestions,
      show_webauthn_credentials, show_identity_credentials);
  if (!generating_selected_account_suggestions_ || !selected_account_context_ ||
      !fill_data_ || !HasSelectedAccountContext(*fill_data_) ||
      !username_filter.empty()) {
    return suggestions;
  }

  const auto first =
      std::ranges::find_if(suggestions, IsPasswordOrBackupSuggestion);
  const auto last =
      std::find_if_not(first, suggestions.end(), IsPasswordOrBackupSuggestion);
  const auto& username = selected_account_context_->username;
  if (std::none_of(first, last, [&](const auto& suggestion) {
        return IsPasswordSuggestion(suggestion) &&
               SuggestionMatchesSelectedUsername(suggestion, username);
      })) {
    return suggestions;
  }

  // Change only the order of existing password rows. Keep their payloads,
  // store identity, recovery entries, and all non-password sections intact.
  std::stable_partition(first, last, [&](const auto& suggestion) {
    return SuggestionMatchesSelectedUsername(suggestion, username);
  });
  return suggestions;
}

}  // namespace password_manager
#endif  // BUILDFLAG(IS_WIN)
