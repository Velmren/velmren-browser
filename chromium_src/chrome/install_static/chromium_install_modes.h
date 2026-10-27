/* Copyright (c) 2020 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Brand-specific types and constants for Google Chrome.

#ifndef BRAVE_CHROMIUM_SRC_CHROME_INSTALL_STATIC_CHROMIUM_INSTALL_MODES_H_
#define BRAVE_CHROMIUM_SRC_CHROME_INSTALL_STATIC_CHROMIUM_INSTALL_MODES_H_

#include <stdlib.h>

#include <array>

#include "brave/components/brave_origin/buildflags/buildflags.h"
#include "chrome/app/chrome_dll_resource.h"
#include "chrome/common/chrome_icon_resources_win.h"
#include "chrome/install_static/install_constants.h"

namespace install_static {

// Brand-specific constants and install modes for Brave.

// The brand-specific company name to be included as a component of the install
// and user data directory paths. May be empty if no such dir is to be used.
inline constexpr wchar_t kCompanyPathName[] = L"Velmren";

// The brand-specific product name to be included as a component of the install
// and user data directory paths.
#if defined(OFFICIAL_BUILD)
#if BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)
// Brave Origin uses "Brave-Origin" instead of "Velmren-Browser" to allow
// side-by-side installation with Brave Browser.
inline constexpr wchar_t kProductPathName[] = L"Brave-Origin";
#else
inline constexpr wchar_t kProductPathName[] = L"Velmren-Browser";
#endif  // BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)
#else
// If you change this, then you also need to change occurrences of this string
// in mini_installer_constants.cc.
inline constexpr wchar_t kProductPathName[] = L"Velmren-Browser-Development";
#endif

// The brand-specific safe browsing client name.
inline constexpr char kSafeBrowsingName[] = "chromium";

// Note: This list of indices must be kept in sync with the brand-specific
// resource strings in chrome/installer/util/prebuild/create_string_rc.
enum InstallConstantIndex {
#if defined(OFFICIAL_BUILD)
  STABLE_INDEX,
  BETA_INDEX,
  DEV_INDEX,
  NIGHTLY_INDEX,
#else
  DEVELOPER_INDEX,
#endif
  NUM_INSTALL_MODES,
};

#if defined(OFFICIAL_BUILD)

// This is overriding the upstream value and shouldn't be undef'ed
// CHROMIUM_SRC_NOLINT
#define CHROMIUM_INDEX STABLE_INDEX

// Regarding the install switch, use the same values that are in
// chrome/installer/mini_installer/configuration.cc
#if BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)
// Brave Origin uses separate identifiers from Brave Browser to allow
// side-by-side installation and independent update infrastructure.
inline constexpr auto kInstallModes = std::to_array<InstallConstants>({
    // The primary install mode for stable Brave Origin.
    {
        .size = sizeof(InstallConstants),
        .index = STABLE_INDEX,  // The first mode is for stable/beta/dev.
        .install_switch =
            "",  // No install switch for the primary install mode.
        .install_suffix =
            L"",  // Empty install suffix - "Origin" is in kProductPathName.
        .logo_suffix = L"",  // No logo suffix for the primary install mode.
        .app_guid = L"{F1EF32DE-F987-4289-81D2-6C4780027F9B}",
        .base_app_name = L"Brave Origin",         // A distinct base_app_name.
        .base_app_id = L"BraveOrigin",            // A distinct base_app_id.
        .browser_prog_id_prefix = L"BraveOHTML",  // Browser ProgID prefix.
        .browser_prog_id_description =
            L"Brave Origin HTML Document",  // Browser ProgID description.
        .direct_launch_url_scheme = "brave-origin",
        .pdf_prog_id_prefix = L"BraveOPDF",  // PDF ProgID prefix.
        .pdf_prog_id_description =
            L"Brave Origin PDF Document",  // PDF ProgID description.
        .active_setup_guid =
            L"{F1EF32DE-F987-4289-81D2-6C4780027F9B}",  // Active Setup GUID.
        .toast_activator_clsid = {0x8a7b6c5d,
                                  0x4e3f,
                                  0x2a1b,
                                  {0x9c, 0x8d, 0x7e, 0x6f, 0x5a, 0x4b, 0x3c,
                                   0x2d}},  // Toast activator CLSID.
        .elevator_clsid = {0x1a2b3c4d,
                           0x5e6f,
                           0x7a8b,
                           {0x9c, 0x0d, 0x1e, 0x2f, 0x3a, 0x4b, 0x5c,
                            0x6d}},  // Elevator CLSID.
        .elevator_iid = {0x2b3c4d5e,
                         0x6f7a,
                         0x8b9c,
                         {0x0d, 0x1e, 0x2f, 0x3a, 0x4b, 0x5c, 0x6d, 0x7e}},
        .default_channel_name = L"",  // The empty string means "stable".
        .channel_strategy = ChannelStrategy::FLOATING,
        .supports_system_level = true,  // Supports system-level installs.
        .supports_set_as_default_browser =
            true,  // Supports in-product set as default browser UX.
        .app_icon_resource_index =
            icon_resources::kApplicationIndex,  // App icon resource index.
        .app_icon_resource_id = IDR_MAINFRAME,  // App icon resource id.
        .sandbox_sid_prefix =
            L"S-1-15-2-3251537155-1984446955-2931258699-841473695-1938553385-"
            L"934012153-",  // App container sid prefix for sandbox.
    },
    // A secondary install mode for Brave Origin Beta
    {
        .size = sizeof(InstallConstants),
        .index = BETA_INDEX,  // The mode for the side-by-side beta channel.
        .install_switch = "chrome-beta",  // Install switch.
        .install_suffix = L"-Beta",       // Install suffix.
        .logo_suffix = L"Beta",           // Logo suffix.
        .app_guid =
            L"{56DA94FD-D872-416B-BFC4-1D7011DA7473}",  // A distinct app GUID.
        .base_app_name = L"Brave Origin Beta",     // A distinct base_app_name.
        .base_app_id = L"BraveOriginBeta",         // A distinct base_app_id.
        .browser_prog_id_prefix = L"BraveOBHTML",  // Browser ProgID prefix.
        .browser_prog_id_description =
            L"Brave Origin Beta HTML Document",  // Browser ProgID description.
        .direct_launch_url_scheme = "brave-origin-beta",
        .pdf_prog_id_prefix = L"BraveOBPDF",  // PDF ProgID prefix.
        .pdf_prog_id_description =
            L"Brave Origin Beta PDF Document",  // PDF ProgID description.
        .active_setup_guid =
            L"{56DA94FD-D872-416B-BFC4-1D7011DA7473}",  // Active Setup GUID.
        .toast_activator_clsid = {0x3c4d5e6f,
                                  0x7a8b,
                                  0x9c0d,
                                  {0x1e, 0x2f, 0x3a, 0x4b, 0x5c, 0x6d, 0x7e,
                                   0x8f}},  // Toast activator CLSID.
        .elevator_clsid = {0x4d5e6f7a,
                           0x8b9c,
                           0x0d1e,
                           {0x2f, 0x3a, 0x4b, 0x5c, 0x6d, 0x7e, 0x8f,
                            0x9a}},  // Elevator CLSID.
        .elevator_iid = {0x5e6f7a8b,
                         0x9c0d,
                         0x1e2f,
                         {0x3a, 0x4b, 0x5c, 0x6d, 0x7e, 0x8f, 0x9a, 0x0b}},
        .default_channel_name = L"beta",  // Forced channel name.
        .channel_strategy = ChannelStrategy::FIXED,
        .supports_system_level = true,  // Supports system-level installs.
        .supports_set_as_default_browser =
            true,  // Supports in-product set as default browser UX.
        .app_icon_resource_index =
            icon_resources::kBetaApplicationIndex,  // App icon resource index.
        .app_icon_resource_id = IDR_X005_BETA,      // App icon resource id.
        .sandbox_sid_prefix =
            L"S-1-15-2-3251537155-1984446955-2931258699-841473695-1938553385-"
            L"934012154-",  // App container sid prefix for sandbox.
    },
    // A secondary install mode for Brave Origin Dev
    {
        .size = sizeof(InstallConstants),
        .index = DEV_INDEX,  // The mode for the side-by-side dev channel.
        .install_switch = "chrome-dev",  // Install switch.
        .install_suffix = L"-Dev",       // Install suffix.
        .logo_suffix = L"Dev",           // Logo suffix.
        .app_guid =
            L"{716D6A4A-D071-47A8-AC64-DBDE3EE3797B}",  // A distinct app GUID.
        .base_app_name = L"Brave Origin Dev",      // A distinct base_app_name.
        .base_app_id = L"BraveOriginDev",          // A distinct base_app_id.
        .browser_prog_id_prefix = L"BraveODHTML",  // Browser ProgID prefix.
        .browser_prog_id_description =
            L"Brave Origin Dev HTML Document",  // Browser ProgID description.
        .direct_launch_url_scheme = "brave-origin-dev",
        .pdf_prog_id_prefix = L"BraveODPDF",  // PDF ProgID prefix.
        .pdf_prog_id_description =
            L"Brave Origin Dev PDF Document",  // PDF ProgID description.
        .active_setup_guid =
            L"{716D6A4A-D071-47A8-AC64-DBDE3EE3797B}",  // Active Setup GUID.
        .toast_activator_clsid = {0x6f7a8b9c,
                                  0x0d1e,
                                  0x2f3a,
                                  {0x4b, 0x5c, 0x6d, 0x7e, 0x8f, 0x9a, 0x0b,
                                   0x1c}},  // Toast activator CLSID.
        .elevator_clsid = {0x7a8b9c0d,
                           0x1e2f,
                           0x3a4b,
                           {0x5c, 0x6d, 0x7e, 0x8f, 0x9a, 0x0b, 0x1c,
                            0x2d}},  // Elevator CLSID.
        .elevator_iid = {0x8b9c0d1e,
                         0x2f3a,
                         0x4b5c,
                         {0x6d, 0x7e, 0x8f, 0x9a, 0x0b, 0x1c, 0x2d, 0x3e}},
        .default_channel_name = L"dev",  // Forced channel name.
        .channel_strategy = ChannelStrategy::FIXED,
        .supports_system_level = true,  // Supports system-level installs.
        .supports_set_as_default_browser =
            true,  // Supports in-product set as default browser UX.
        .app_icon_resource_index =
            icon_resources::kDevApplicationIndex,  // App icon resource index.
        .app_icon_resource_id = IDR_X004_DEV,      // App icon resource id.
        .sandbox_sid_prefix =
            L"S-1-15-2-3251537155-1984446955-2931258699-841473695-1938553385-"
            L"934012155-",  // App container sid prefix for sandbox.
    },
    // A secondary install mode for Brave Origin SxS (nightly).
    {
        .size = sizeof(InstallConstants),
        .index =
            NIGHTLY_INDEX,  // The mode for the side-by-side nightly channel.
        .install_switch = "chrome-sxs",  // Install switch.
        .install_suffix = L"-Nightly",   // Install suffix.
        .logo_suffix = L"Canary",        // Logo suffix.
        .app_guid =
            L"{50474E96-9CD2-4BC8-B0A7-0D4B6EF2E709}",  // A distinct app GUID.
        .base_app_name = L"Brave Origin Nightly",  // A distinct base_app_name.
        .base_app_id = L"BraveOriginNightly",      // A distinct base_app_id.
        .browser_prog_id_prefix = L"BraveOSHTM",   // Browser ProgID prefix.
        .browser_prog_id_description =
            L"Brave Origin Nightly HTML Document",  // Browser ProgID
                                                    // description.
        .direct_launch_url_scheme = "brave-origin-nightly",
        .pdf_prog_id_prefix = L"BraveOSPDF",  // PDF ProgID prefix.
        .pdf_prog_id_description =
            L"Brave Origin Nightly PDF Document",  // PDF ProgID description.
        .active_setup_guid =
            L"{50474E96-9CD2-4BC8-B0A7-0D4B6EF2E709}",  // Active Setup GUID.
        .toast_activator_clsid = {0x9c0d1e2f,
                                  0x3a4b,
                                  0x5c6d,
                                  {0x7e, 0x8f, 0x9a, 0x0b, 0x1c, 0x2d, 0x3e,
                                   0x4f}},  // Toast activator CLSID.
        .elevator_clsid = {0x0d1e2f3a,
                           0x4b5c,
                           0x6d7e,
                           {0x8f, 0x9a, 0x0b, 0x1c, 0x2d, 0x3e, 0x4f,
                            0x5a}},  // Elevator CLSID.
        .elevator_iid = {0x1e2f3a4b,
                         0x5c6d,
                         0x7e8f,
                         {0x9a, 0x0b, 0x1c, 0x2d, 0x3e, 0x4f, 0x5a, 0x6b}},
        .default_channel_name = L"nightly",  // Forced channel name.
        .channel_strategy = ChannelStrategy::FIXED,
        .supports_system_level = true,  // Support system-level installs.
        .supports_set_as_default_browser =
            true,  // Support in-product set as default browser UX.
        .app_icon_resource_index =
            icon_resources::kSxSApplicationIndex,  // App icon resource index.
        .app_icon_resource_id = IDR_SXS,           // App icon resource id.
        .sandbox_sid_prefix =
            L"S-1-15-2-3251537155-1984446955-2931258699-841473695-1938553385-"
            L"934012156-",  // App container sid prefix for sandbox.
    },
});
#else   // !BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)
inline constexpr auto kInstallModes = std::to_array<InstallConstants>({
    // The primary install mode for stable Brave.
    {
        .size = sizeof(InstallConstants),
        .index = STABLE_INDEX,  // The first mode is for stable/beta/dev.
        .install_switch =
            "",  // No install switch for the primary install mode.
        .install_suffix =
            L"",  // Empty install_suffix for the primary install mode.
        .logo_suffix = L"",  // No logo suffix for the primary install mode.
        .app_guid = L"{75101CDB-9EB9-5758-8C34-28494CE037AD}",
        .base_app_name = L"Velmren",               // A distinct base_app_name.
        .base_app_id = L"Velmren",                 // A distinct base_app_id.
        .browser_prog_id_prefix = L"VelmrenHTML",  // Browser ProgID prefix.
        .browser_prog_id_description =
            L"Velmren HTML Document",  // Browser ProgID description.
        .direct_launch_url_scheme = "velmren-browser",
        .pdf_prog_id_prefix = L"VelmrenPDF",  // PDF ProgID prefix.
        .pdf_prog_id_description =
            L"Velmren PDF Document",  // PDF ProgID description.
        .active_setup_guid =
            L"{75101CDB-9EB9-5758-8C34-28494CE037AD}",  // Active Setup GUID.
        .toast_activator_clsid = {0x5998eb7e,
                                  0x6519,
                                  0x51ae,
                                  {0xb9, 0x88, 0x80, 0xb1, 0xc7, 0x17, 0x21,
                                   0x59}},  // Toast activator CLSID.
        .elevator_clsid = {0xec30dfed,
                           0xcfbb,
                           0x5c69,
                           {0x82, 0xef, 0xe4, 0xd5, 0x1d, 0x0d, 0x86,
                            0xc6}},  // Elevator CLSID.
        .elevator_iid = {0x407578a3,
                         0xc18b,
                         0x5138,
                         {0xbb, 0x1f, 0xfb, 0x3d, 0x52, 0x9f, 0x1c, 0x0d}},
        .default_channel_name = L"",  // The empty string means "stable".
        .channel_strategy = ChannelStrategy::FLOATING,
        .supports_system_level = true,  // Supports system-level installs.
        .supports_set_as_default_browser =
            true,  // Supports in-product set as default browser UX.
        .app_icon_resource_index =
            icon_resources::kApplicationIndex,  // App icon resource index.
        .app_icon_resource_id = IDR_MAINFRAME,  // App icon resource id.
        .sandbox_sid_prefix =
            L"S-1-15-2-2149060189-2418730926-3966812758-1819624003-2059915740-"
            L"208470149-",  // App container sid prefix for sandbox.
    },
    // A secondary install mode for Brave Beta
    {
        .size = sizeof(InstallConstants),
        .index = BETA_INDEX,  // The mode for the side-by-side beta channel.
        .install_switch = "chrome-beta",  // Install switch.
        .install_suffix = L"-Beta",       // Install suffix.
        .logo_suffix = L"Beta",           // Logo suffix.
        .app_guid =
            L"{1BBEEEC2-53AC-59A6-BA89-D0D71570C072}",  // A distinct app GUID.
        .base_app_name = L"Velmren Beta",        // A distinct base_app_name.
        .base_app_id = L"VelmrenBeta",           // A distinct base_app_id.
        .browser_prog_id_prefix = L"VelmBHTML",  // Browser ProgID prefix.
        .browser_prog_id_description =
            L"Velmren Beta HTML Document",  // Browser ProgID description.
        .direct_launch_url_scheme = "velmren-browser-beta",
        .pdf_prog_id_prefix = L"VelmBPDF",  // PDF ProgID prefix.
        .pdf_prog_id_description =
            L"Velmren Beta PDF Document",  // PDF ProgID description.
        .active_setup_guid =
            L"{1BBEEEC2-53AC-59A6-BA89-D0D71570C072}",  // Active Setup GUID.
        .toast_activator_clsid = {0x16f8880e,
                                  0x874c,
                                  0x5e78,
                                  {0xbc, 0x00, 0xc8, 0xcc, 0x28, 0x20, 0x7c,
                                   0xa2}},  // Toast activator CLSID.
        .elevator_clsid = {0xd40d77d5,
                           0x0bc6,
                           0x55bf,
                           {0x8a, 0xec, 0x7a, 0xf1, 0x54, 0x4c, 0xb7,
                            0xf8}},  // Elevator CLSID.
        .elevator_iid = {0x25247d6b,
                         0xb4a2,
                         0x5ecb,
                         {0xbf, 0xbb, 0xd3, 0xc3, 0x29, 0x53, 0xf3, 0x49}},
        .default_channel_name = L"beta",  // Forced channel name.
        .channel_strategy = ChannelStrategy::FIXED,
        .supports_system_level = true,  // Supports system-level installs.
        .supports_set_as_default_browser =
            true,  // Supports in-product set as default browser UX.
        .app_icon_resource_index =
            icon_resources::kBetaApplicationIndex,  // App icon resource index.
        .app_icon_resource_id = IDR_X005_BETA,      // App icon resource id.
        .sandbox_sid_prefix =
            L"S-1-15-2-2149060189-2418730926-3966812758-1819624003-2059915740-"
            L"208470150-",  // App container sid prefix for sandbox.
    },
    // A secondary install mode for Brave Dev
    {
        .size = sizeof(InstallConstants),
        .index = DEV_INDEX,  // The mode for the side-by-side dev channel.
        .install_switch = "chrome-dev",  // Install switch.
        .install_suffix = L"-Dev",       // Install suffix.
        .logo_suffix = L"Dev",           // Logo suffix.
        .app_guid =
            L"{74B9E6E2-AD1E-5888-8F4C-8F3D08635EF0}",  // A distinct app GUID.
        .base_app_name = L"Velmren Dev",         // A distinct base_app_name.
        .base_app_id = L"VelmrenDev",            // A distinct base_app_id.
        .browser_prog_id_prefix = L"VelmDHTML",  // Browser ProgID prefix.
        .browser_prog_id_description =
            L"Velmren Dev HTML Document",  // Browser ProgID description.
        .direct_launch_url_scheme = "velmren-browser-dev",
        .pdf_prog_id_prefix = L"VelmDPDF",  // PDF ProgID prefix.
        .pdf_prog_id_description =
            L"Velmren Dev PDF Document",  // PDF ProgID description.
        .active_setup_guid =
            L"{74B9E6E2-AD1E-5888-8F4C-8F3D08635EF0}",  // Active Setup GUID.
        .toast_activator_clsid = {0xad98ee36,
                                  0x34fb,
                                  0x53a7,
                                  {0x9c, 0x87, 0x4d, 0x34, 0x00, 0xb2, 0x98,
                                   0x65}},  // Toast activator CLSID.
        .elevator_clsid = {0x24fb6607,
                           0xbac7,
                           0x5cff,
                           {0xb7, 0xe2, 0xca, 0x53, 0x1b, 0x2a, 0xb8,
                            0x40}},  // Elevator CLSID.
        .elevator_iid = {0x3f6aaaf6,
                         0xf875,
                         0x5e3c,
                         {0xb0, 0x54, 0x2a, 0x1d, 0xee, 0x2f, 0x78, 0xca}},
        .default_channel_name = L"dev",  // Forced channel name.
        .channel_strategy = ChannelStrategy::FIXED,
        .supports_system_level = true,  // Supports system-level installs.
        .supports_set_as_default_browser =
            true,  // Supports in-product set as default browser UX.
        .app_icon_resource_index =
            icon_resources::kDevApplicationIndex,  // App icon resource index.
        .app_icon_resource_id = IDR_X004_DEV,      // App icon resource id.
        .sandbox_sid_prefix =
            L"S-1-15-2-2149060189-2418730926-3966812758-1819624003-2059915740-"
            L"208470151-",  // App container sid prefix for sandbox.
    },
    // A secondary install mode for Brave SxS (canary).
    {
        .size = sizeof(InstallConstants),
        .index =
            NIGHTLY_INDEX,  // The mode for the side-by-side nightly channel.
        .install_switch = "chrome-sxs",  // Install switch.
        .install_suffix = L"-Nightly",   // Install suffix.
        .logo_suffix = L"Canary",        // Logo suffix.
        .app_guid =
            L"{83BCFA56-B05F-59E1-9442-A00C02CE251A}",  // A distinct app GUID.
        .base_app_name = L"Velmren Nightly",     // A distinct base_app_name.
        .base_app_id = L"VelmrenNightly",        // A distinct base_app_id.
        .browser_prog_id_prefix = L"VelmSSHTM",  // Browser ProgID prefix.
        .browser_prog_id_description =
            L"Velmren Nightly HTML Document",  // Browser ProgID description.
        .direct_launch_url_scheme = "velmren-browser-nightly",
        .pdf_prog_id_prefix = L"VelmSSPDF",  // PDF ProgID prefix.
        .pdf_prog_id_description =
            L"Velmren Nightly PDF Document",  // PDF ProgID description.
        .active_setup_guid =
            L"{83BCFA56-B05F-59E1-9442-A00C02CE251A}",  // Active Setup GUID.
        .toast_activator_clsid = {0xd757d6e5,
                                  0x657c,
                                  0x5b6d,
                                  {0x85, 0xe4, 0xec, 0xc5, 0xd5, 0xba, 0xc7,
                                   0xd9}},  // Toast activator CLSID.
        .elevator_clsid = {0x3adbff95,
                           0xb070,
                           0x5d4e,
                           {0x93, 0x18, 0xbc, 0x08, 0xac, 0x04, 0x30,
                            0xef}},  // Elevator CLSID.
        .elevator_iid = {0xd236c5df,
                         0x36ff,
                         0x5066,
                         {0x9c, 0xb7, 0xdc, 0x69, 0xec, 0x21, 0xed, 0xd0}},
        .default_channel_name = L"nightly",  // Forced channel name.
        .channel_strategy = ChannelStrategy::FIXED,
        .supports_system_level = true,  // Support system-level installs.
        .supports_set_as_default_browser =
            true,  // Support in-product set as default browser UX.
        .app_icon_resource_index =
            icon_resources::kSxSApplicationIndex,  // App icon resource index.
        .app_icon_resource_id = IDR_SXS,           // App icon resource id.
        .sandbox_sid_prefix =
            L"S-1-15-2-2149060189-2418730926-3966812758-1819624003-2059915740-"
            L"208470152-",  // App container sid prefix for sandbox.
    },
});
#endif  // BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)
#else

// CHROMIUM_SRC_NOLINT
#define CHROMIUM_INDEX DEVELOPER_INDEX

inline constexpr auto kInstallModes = std::to_array<InstallConstants>({
    // The primary (and only) install mode for Brave developer build.
    {
        .size = sizeof(InstallConstants),
        .index = DEVELOPER_INDEX,  // The one and only mode for developer mode.
        .install_switch =
            "",  // No install switch for the primary install mode.
        .install_suffix =
            L"",  // Empty install_suffix for the primary install mode.
        .logo_suffix = L"",  // No logo suffix for the primary install mode.
        .app_guid =
            L"",  // Empty app_guid since no integraion with Brave Update.
        .base_app_name = L"Velmren Development",  // A distinct base_app_name.
        .base_app_id = L"VelmrenDevelopment",     // A distinct base_app_id.
        .browser_prog_id_prefix = L"VelmDevHTM",  // Browser ProgID prefix.
        .browser_prog_id_description =
            L"Velmren Development HTML Document",  // Browser ProgID
                                                   // description.
        .direct_launch_url_scheme = "velmren-browser-development",
        .pdf_prog_id_prefix = L"VelmDevPDF",  // PDF ProgID prefix.
        .pdf_prog_id_description =
            L"Velmren Development PDF Document",  // PDF ProgID description.
        .active_setup_guid =
            L"{9787A436-68F2-5126-B49F-4C4D54FF3EAE}",  // Active Setup GUID.
        .toast_activator_clsid = {0x0bc526db,
                                  0xefdf,
                                  0x5003,
                                  {0x8d, 0xb6, 0x1a, 0xc1, 0x69, 0xba, 0x0f,
                                   0xdf}},  // Toast activator CLSID.
        .elevator_clsid = {0x68a4fcbc,
                           0x7a11,
                           0x5239,
                           {0x91, 0x11, 0x2f, 0xe0, 0xb8, 0xcf, 0xf1,
                            0xc9}},  // Elevator CLSID.
        .elevator_iid = {0xd9891b9b,
                         0x1d2f,
                         0x5944,
                         {0xb0, 0x43, 0x31, 0x00, 0x2a, 0xdc, 0x86, 0x4e}},
        .default_channel_name =
            L"",  // Empty default channel name since no update integration.
        .channel_strategy = ChannelStrategy::UNSUPPORTED,
        .supports_system_level = true,  // Supports system-level installs.
        .supports_set_as_default_browser =
            true,  // Supports in-product set as default browser UX.
        .app_icon_resource_index =
            icon_resources::kApplicationIndex,  // App icon resource index.
        .app_icon_resource_id = IDR_MAINFRAME,  // App icon resource id.
        .sandbox_sid_prefix =
            L"S-1-15-2-2149060189-2418730926-3966812758-1819624003-2059915740-"
            L"208470148-",  // App container sid prefix for sandbox.
    },
});
#endif

}  // namespace install_static

#endif  // BRAVE_CHROMIUM_SRC_CHROME_INSTALL_STATIC_CHROMIUM_INSTALL_MODES_H_
