/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_CHROME_BROWSER_PROFILES_PROFILE_SHORTCUT_MANAGER_WIN_H_
#define BRAVE_CHROMIUM_SRC_CHROME_BROWSER_PROFILES_PROFILE_SHORTCUT_MANAGER_WIN_H_

#include "chrome/browser/profiles/profile_shortcut_manager.h"

#define GetShortcutProperties(...)               \
  GetShortcutProperties_ChromiumImpl(__VA_ARGS__); \
  void GetShortcutProperties(__VA_ARGS__)

#include <chrome/browser/profiles/profile_shortcut_manager_win.h>  // IWYU pragma: export

#undef GetShortcutProperties

#endif  // BRAVE_CHROMIUM_SRC_CHROME_BROWSER_PROFILES_PROFILE_SHORTCUT_MANAGER_WIN_H_
