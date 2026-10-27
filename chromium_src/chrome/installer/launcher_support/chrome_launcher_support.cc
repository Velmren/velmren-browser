/* Copyright (c) 2024 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/components/brave_origin/buildflags/buildflags.h"

namespace chrome_launcher_support {
namespace {

// Brave Update registry settings.
const wchar_t kInstallationRegKey[] = L"Software\\Velmren\\Update\\ClientState";

// Copied from brave/chromium_src/chrome/install_static/chromium_install_modes.h
#if BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)
const wchar_t kBrowserAppGuid[] = L"{F1EF32DE-F987-4289-81D2-6C4780027F9B}";
const wchar_t kSxSBrowserAppGuid[] = L"{50474E96-9CD2-4BC8-B0A7-0D4B6EF2E709}";
#else
const wchar_t kBrowserAppGuid[] = L"{75101CDB-9EB9-5758-8C34-28494CE037AD}";
const wchar_t kSxSBrowserAppGuid[] = L"{83BCFA56-B05F-59E1-9442-A00C02CE251A}";
#endif  // BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)

// Copied from util_constants.cc.
const wchar_t kChromeExe[] = L"velmren.exe";

}  // namespace
}  // namespace chrome_launcher_support

#include <chrome/installer/launcher_support/chrome_launcher_support.cc>
