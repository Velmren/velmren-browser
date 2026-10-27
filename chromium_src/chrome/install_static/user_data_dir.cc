/* Copyright (c) 2025 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "chrome/install_static/user_data_dir.h"

#include <string>

#include "chrome/install_static/install_util.h"

namespace install_static {

std::wstring& BraveAppendChromeInstallSubDirectory(const InstallConstants& mode,
                                                   bool include_suffix,
                                                   std::wstring* path);

}  // namespace install_static

#define AppendChromeInstallSubDirectory BraveAppendChromeInstallSubDirectory

#include <chrome/install_static/user_data_dir.cc>

#undef AppendChromeInstallSubDirectory

namespace install_static {

std::wstring& BraveAppendChromeInstallSubDirectory(const InstallConstants& mode,
                                                   bool include_suffix,
                                                   std::wstring* path) {
  AppendChromeInstallSubDirectory(mode, include_suffix, path);
  // Use the independent Velmren policy namespace.
  if (!include_suffix && path->starts_with(L"SOFTWARE\\Policies\\") &&
      path->ends_with(kProductPathName)) {
    *path = path->substr(0, (path->length() - kProductPathNameLength));
    path->append(L"Velmren");
  }

  return *path;
}

}  // namespace install_static
