/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "chrome/browser/profiles/profile_shortcut_manager_win.h"

#include <utility>

#include "brave/browser/velmren_delivery_win.h"

#define GetShortcutProperties GetShortcutProperties_ChromiumImpl
#include <chrome/browser/profiles/profile_shortcut_manager_win.cc>
#undef GetShortcutProperties

void ProfileShortcutManagerWin::GetShortcutProperties(
    const base::FilePath& profile_path,
    base::CommandLine* command_line,
    std::wstring* name,
    base::FilePath* icon_path) {
  GetShortcutProperties_ChromiumImpl(profile_path, command_line, name, icon_path);
  if (auto delivery_command = velmren::delivery::MakeBrowserCommand(
          command_line->GetProgram(), profile_path)) {
    *command_line = std::move(*delivery_command);
  }
}
