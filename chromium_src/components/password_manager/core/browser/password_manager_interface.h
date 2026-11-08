/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_COMPONENTS_PASSWORD_MANAGER_CORE_BROWSER_PASSWORD_MANAGER_INTERFACE_H_
#define BRAVE_CHROMIUM_SRC_COMPONENTS_PASSWORD_MANAGER_CORE_BROWSER_PASSWORD_MANAGER_INTERFACE_H_

#include <optional>
#include <string>

#include "build/build_config.h"
#include "components/autofill/core/common/form_data.h"
#include "components/password_manager/core/browser/password_manager_driver.h"

#if BUILDFLAG(IS_WIN)
#define BRAVE_PASSWORD_MANAGER_INTERFACE_RECENT_USERNAME                 \
  virtual std::optional<std::u16string> GetRecentUsernameForSuggestions( \
      const PasswordManagerDriver& driver,                               \
      const autofill::FormData& password_form) const;
#else
#define BRAVE_PASSWORD_MANAGER_INTERFACE_RECENT_USERNAME
#endif

#include <components/password_manager/core/browser/password_manager_interface.h>  // IWYU pragma: export

#undef BRAVE_PASSWORD_MANAGER_INTERFACE_RECENT_USERNAME

#endif  // BRAVE_CHROMIUM_SRC_COMPONENTS_PASSWORD_MANAGER_CORE_BROWSER_PASSWORD_MANAGER_INTERFACE_H_
