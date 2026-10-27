/* Copyright (c) 2021 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "chrome/installer/util/google_update_constants.h"

#include "brave/components/brave_origin/buildflags/buildflags.h"

#define kChromeUpgradeCode kChromeUpgradeCode_Unused
#define kGoogleUpdateUpgradeCode kGoogleUpdateUpgradeCode_Unused
#define kGoogleUpdateSetupExe kGoogleUpdateSetupExe_Unused
#define kRegPathClients kRegPathClients_Unused
#define kRegPathClientState kRegPathClientState_Unused
#define kRegPathClientStateMedium kRegPathClientStateMedium_Unused
#define kRegPathGoogleUpdate kRegPathGoogleUpdate_Unused

#include <chrome/installer/util/google_update_constants.cc>

#undef kChromeUpgradeCode
#undef kGoogleUpdateUpgradeCode
#undef kGoogleUpdateSetupExe
#undef kRegPathClients
#undef kRegPathClientState
#undef kRegPathClientStateMedium
#undef kRegPathGoogleUpdate

namespace google_update {

// kChromeUpgradeCode is browser-specific to allow side-by-side installation.
#if BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)
const wchar_t kChromeUpgradeCode[] = L"{F1EF32DE-F987-4289-81D2-6C4780027F9B}";
#else
const wchar_t kChromeUpgradeCode[] = L"{75101CDB-9EB9-5758-8C34-28494CE037AD}";
#endif

// Updater constants are shared between Brave Browser and Brave Origin since
// they use the same updater infrastructure.
const wchar_t kGoogleUpdateUpgradeCode[] =
    L"{B131C935-9BE6-41DA-9599-1F776BEB8019}";
const wchar_t kGoogleUpdateSetupExe[] = L"VelmrenUpdateSetup.exe";
const wchar_t kRegPathClients[] = L"Software\\Velmren\\Update\\Clients";
const wchar_t kRegPathClientState[] = L"Software\\Velmren\\Update\\ClientState";
const wchar_t kRegPathClientStateMedium[] =
    L"Software\\Velmren\\Update\\ClientStateMedium";
const wchar_t kRegPathGoogleUpdate[] = L"Software\\Velmren\\Update";

}  // namespace google_update
