/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_COMPONENTS_VERSION_INFO_VELMREN_VERSION_INFO_H_
#define BRAVE_COMPONENTS_VERSION_INFO_VELMREN_VERSION_INFO_H_

#include <optional>
#include <string>

namespace base {
class FilePath;
}

namespace version_info {

// Cosmetic release identity only, never update or installation authority.
// Recognizes <root>/versions/<four-part-version>/app/browser/velmren.exe.
std::optional<std::string> GetVelmrenReleaseVersionFromExecutablePath(
    const base::FilePath& executable_path);

// Uses the running executable, so a retained release reports its own version.
std::optional<std::string> GetVelmrenReleaseVersion();

// Non-installed builds have an explicit development label, not a release
// number.
std::string GetVelmrenProductVersionForDisplay();
std::string GetVelmrenVersionNumberForDisplay();

}  // namespace version_info

#endif  // BRAVE_COMPONENTS_VERSION_INFO_VELMREN_VERSION_INFO_H_
