/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/components/version_info/velmren_version_info.h"

#include <algorithm>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <string_view>

#include "base/base_paths.h"
#include "base/files/file_path.h"
#include "base/path_service.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/version.h"
#include "brave/components/version_info/version_info.h"

namespace version_info {

std::optional<std::string> GetVelmrenReleaseVersionFromExecutablePath(
    const base::FilePath& executable_path) {
  if (!executable_path.IsAbsolute() || executable_path.ReferencesParent() ||
      executable_path.EndsWithSeparator()) {
    return std::nullopt;
  }

  auto path = executable_path;
  for (std::string_view component : {"velmren.exe", "browser", "app"}) {
    if (!base::EqualsCaseInsensitiveASCII(path.BaseName().MaybeAsASCII(),
                                          component)) {
      return std::nullopt;
    }
    path = path.DirName();
  }

  const std::string release = path.BaseName().MaybeAsASCII();
  if (!base::EqualsCaseInsensitiveASCII(
          path.DirName().BaseName().MaybeAsASCII(), "versions")) {
    return std::nullopt;
  }

  const base::Version version(release);
  if (!version.IsValid() || version.components().size() != 4 ||
      version.GetString() != release ||
      std::ranges::any_of(version.components(), [](uint32_t component) {
        // Match the delivery engine's System.Version component range.
        return component >
               static_cast<uint32_t>(std::numeric_limits<int32_t>::max());
      })) {
    return std::nullopt;
  }
  return release;
}

std::optional<std::string> GetVelmrenReleaseVersion() {
  base::FilePath executable_path;
  if (!base::PathService::Get(base::FILE_EXE, &executable_path)) {
    return std::nullopt;
  }
  return GetVelmrenReleaseVersionFromExecutablePath(executable_path);
}

std::string GetVelmrenProductVersionForDisplay() {
  return GetVelmrenReleaseVersion().value_or("Development build");
}

std::string GetVelmrenVersionNumberForDisplay() {
  return base::StrCat(
      {GetVelmrenProductVersionForDisplay(),
       " Chromium: ", GetBraveChromiumVersionNumber(),
       " (Brave: ", GetBraveVersionWithoutChromiumMajorVersion(), ")"});
}

}  // namespace version_info
