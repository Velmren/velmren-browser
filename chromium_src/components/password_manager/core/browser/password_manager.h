/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_COMPONENTS_PASSWORD_MANAGER_CORE_BROWSER_PASSWORD_MANAGER_H_
#define BRAVE_CHROMIUM_SRC_COMPONENTS_PASSWORD_MANAGER_CORE_BROWSER_PASSWORD_MANAGER_H_

#include "build/build_config.h"

// Preserve Brave's built-in Android backend preference registration.
#define RegisterProfilePrefs                       \
  RegisterProfilePrefs_ChromiumImpl(               \
      user_prefs::PrefRegistrySyncable* registry); \
  static void RegisterProfilePrefs

#if BUILDFLAG(IS_WIN)
#define BRAVE_PASSWORD_MANAGER_RECENT_USERNAME                   \
  std::optional<std::u16string> GetRecentUsernameForSuggestions( \
      const PasswordManagerDriver& driver,                       \
      const autofill::FormData& password_form) const override;
#define BRAVE_PASSWORD_MANAGER_RECENT_USERNAME_PRIVATE        \
  std::optional<DriverId> recent_main_frame_username_driver_; \
  bool username_first_submission_navigation_ = false;
#else
#define BRAVE_PASSWORD_MANAGER_RECENT_USERNAME
#define BRAVE_PASSWORD_MANAGER_RECENT_USERNAME_PRIVATE
#endif

#include <components/password_manager/core/browser/password_manager.h>  // IWYU pragma: export

#undef RegisterProfilePrefs
#undef BRAVE_PASSWORD_MANAGER_RECENT_USERNAME
#undef BRAVE_PASSWORD_MANAGER_RECENT_USERNAME_PRIVATE

#endif  // BRAVE_CHROMIUM_SRC_COMPONENTS_PASSWORD_MANAGER_CORE_BROWSER_PASSWORD_MANAGER_H_
