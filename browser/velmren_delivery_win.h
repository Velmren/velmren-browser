/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_BROWSER_VELMREN_DELIVERY_WIN_H_
#define BRAVE_BROWSER_VELMREN_DELIVERY_WIN_H_

#include <optional>

#include "base/command_line.h"
#include "base/files/file_path.h"

namespace velmren::delivery {

// Recognizes only the delivery layout, with existing installation markers.
// The launcher remains responsible for validating ownership and signed files.
std::optional<base::FilePath> FindInstalledRoot(
    const base::FilePath& executable);

// Uses the profile's actual parent directory, including for direct EXE launches.
std::optional<base::CommandLine> MakeBrowserCommand(
    const base::FilePath& executable,
    const base::FilePath& profile_path,
    bool incognito = false,
    bool new_window = false);

bool IsOrdinaryBrowserCommand(const base::CommandLine& command_line);

// File checks and process creation run on a worker without delaying the browser.
void MaybeLaunchUpdateMonitor();

}  // namespace velmren::delivery

#endif  // BRAVE_BROWSER_VELMREN_DELIVERY_WIN_H_
