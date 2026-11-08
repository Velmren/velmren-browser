/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "components/password_manager/core/browser/password_manager.h"

#include <algorithm>

#include "build/build_config.h"
#include "url/origin.h"

#if BUILDFLAG(IS_WIN)
#define BRAVE_PASSWORD_MANAGER_USERNAME_FIRST_NAVIGATION         \
  username_first_submission_navigation_ = form_may_be_submitted; \
  if (!form_may_be_submitted) {                                  \
    recent_main_frame_username_driver_.reset();                  \
  }
#define BRAVE_PASSWORD_MANAGER_USERNAME_FIRST_INPUT       \
  if (driver && driver->IsInPrimaryMainFrame()) {         \
    recent_main_frame_username_driver_ = driver->GetId(); \
  }
#define BRAVE_PASSWORD_MANAGER_USERNAME_FIRST_UPDATE \
  it->second.autocomplete_attribute_has_username =   \
      autocomplete_attribute_has_username;           \
  it->second.is_likely_otp = is_likely_otp;
#else
#define BRAVE_PASSWORD_MANAGER_USERNAME_FIRST_NAVIGATION
#define BRAVE_PASSWORD_MANAGER_USERNAME_FIRST_INPUT
#define BRAVE_PASSWORD_MANAGER_USERNAME_FIRST_UPDATE
#endif

#define RegisterProfilePrefs RegisterProfilePrefs_ChromiumImpl
#include <components/password_manager/core/browser/password_manager.cc>
#undef RegisterProfilePrefs

#undef BRAVE_PASSWORD_MANAGER_USERNAME_FIRST_UPDATE
#undef BRAVE_PASSWORD_MANAGER_USERNAME_FIRST_INPUT
#undef BRAVE_PASSWORD_MANAGER_USERNAME_FIRST_NAVIGATION

namespace password_manager {

void PasswordManager::RegisterProfilePrefs(
    user_prefs::PrefRegistrySyncable* registry) {
  RegisterProfilePrefs_ChromiumImpl(registry);
#if BUILDFLAG(IS_ANDROID)
  registry->RegisterBooleanPref(prefs::kClearingUndecryptablePasswords, false);
#endif
}

#if BUILDFLAG(IS_WIN)
std::optional<std::u16string>
PasswordManagerInterface::GetRecentUsernameForSuggestions(
    const PasswordManagerDriver& driver,
    const autofill::FormData& password_form) const {
  return std::nullopt;
}

std::optional<std::u16string> PasswordManager::GetRecentUsernameForSuggestions(
    const PasswordManagerDriver& driver,
    const autofill::FormData& password_form) const {
  const url::Origin origin = url::Origin::Create(password_form.url());
  if (origin.opaque() || origin != driver.GetLastCommittedOrigin()) {
    return std::nullopt;
  }

  // Reuse Chromium's username-first cache: it expires candidates and clears
  // them on navigation unrelated to a submission. Do not use ordinary text,
  // OTP fields, other frames, or public-suffix matches for suggestion ranking.
  const PossibleUsernameData* latest = nullptr;
  bool ambiguous = false;
  for (const auto& [field_id, candidate] : possible_usernames_) {
    // RenderDocument may replace the main-frame driver between sign-in steps.
    // Only a submission-related main-frame transition can bridge that change.
    const bool same_frame =
        field_id.driver_id == driver.GetId() ||
        (username_first_submission_navigation_ &&
         driver.IsInPrimaryMainFrame() &&
         recent_main_frame_username_driver_ == field_id.driver_id);
    if (!same_frame || candidate.IsStale() ||
        origin != url::Origin::Create(GURL(candidate.signon_realm)) ||
        (field_id.driver_id == driver.GetId() &&
         std::ranges::contains(password_form.fields(), candidate.renderer_id,
                               &autofill::FormFieldData::renderer_id))) {
      continue;
    }
    if (!latest || candidate.last_change > latest->last_change) {
      latest = &candidate;
      ambiguous = false;
    } else if (candidate.last_change == latest->last_change &&
               candidate.value != latest->value) {
      ambiguous = true;
    }
  }
  if (!latest || ambiguous || latest->is_likely_otp ||
      (!latest->autocomplete_attribute_has_username &&
       !latest->HasSingleUsernameServerPrediction())) {
    return std::nullopt;
  }
  return latest->value;
}

#endif  // BUILDFLAG(IS_WIN)

}  // namespace password_manager
