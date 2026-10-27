/* Copyright (c) 2018 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/components/brave_origin/buildflags/buildflags.h"
#include "chrome/installer/mini_installer/appid.h"

namespace google_update {

#if defined(OFFICIAL_BUILD)
#if BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)
// Brave Origin uses separate app GUIDs from Brave Browser to allow
// side-by-side installation and independent update infrastructure.
const wchar_t kAppGuid[] = L"{F1EF32DE-F987-4289-81D2-6C4780027F9B}";
const wchar_t kBetaAppGuid[] = L"{56DA94FD-D872-416B-BFC4-1D7011DA7473}";
const wchar_t kDevAppGuid[] = L"{716D6A4A-D071-47A8-AC64-DBDE3EE3797B}";
const wchar_t kSxSAppGuid[] = L"{50474E96-9CD2-4BC8-B0A7-0D4B6EF2E709}";
#else
const wchar_t kAppGuid[] = L"{75101CDB-9EB9-5758-8C34-28494CE037AD}";
const wchar_t kBetaAppGuid[] = L"{1BBEEEC2-53AC-59A6-BA89-D0D71570C072}";
const wchar_t kDevAppGuid[] = L"{74B9E6E2-AD1E-5888-8F4C-8F3D08635EF0}";
const wchar_t kSxSAppGuid[] = L"{83BCFA56-B05F-59E1-9442-A00C02CE251A}";
#endif  // BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)
#else
const wchar_t kAppGuid[] = L"";
#endif

}  // namespace google_update
