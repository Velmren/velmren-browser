/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/components/version_info/velmren_version_info.h"

#include <initializer_list>
#include <string>
#include <string_view>

#include "base/base_paths.h"
#include "base/files/file_path.h"
#include "base/test/scoped_path_override.h"
#include "brave/components/version_info/version_info.h"
#include "build/build_config.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace version_info {
namespace {

base::FilePath InstallationRoot() {
#if BUILDFLAG(IS_WIN)
  return base::FilePath::FromUTF8Unsafe("C:\\Users\\Иван\\Velmren Browser");
#else
  return base::FilePath::FromUTF8Unsafe("/home/Иван/Velmren Browser");
#endif
}

base::FilePath InstalledExecutable(std::string_view version) {
  return InstallationRoot()
      .AppendASCII("versions")
      .Append(base::FilePath::FromUTF8Unsafe(version))
      .AppendASCII("app")
      .AppendASCII("browser")
      .AppendASCII("velmren.exe");
}

TEST(VelmrenVersionInfoTest, CanonicalDeliveryVersions) {
  for (std::string_view version : {"0.1.0.3", "0.0.0.0", "2147483647.1.2.3"}) {
    SCOPED_TRACE(version);
    EXPECT_EQ(std::string(version), GetVelmrenReleaseVersionFromExecutablePath(
                                        InstalledExecutable(version)));
  }
}

TEST(VelmrenVersionInfoTest, WindowsLayoutIsCaseInsensitive) {
  const auto executable = InstallationRoot()
                              .AppendASCII("VERSIONS")
                              .AppendASCII("0.1.0.3")
                              .AppendASCII("App")
                              .AppendASCII("Browser")
                              .AppendASCII("Velmren.EXE");
  EXPECT_EQ("0.1.0.3", GetVelmrenReleaseVersionFromExecutablePath(executable));
}

TEST(VelmrenVersionInfoTest, RejectsNoncanonicalVersions) {
  for (std::string_view version :
       {"0.1.3", "0.1.0.3.4", "00.1.0.3", "0.01.0.3", "0.1.00.3", "0.1.0.03",
        "0.1.0.-1", "0.1.0.+3", "0.1.0.3beta", "v0.1.0.3", "0.1.0.3 ",
        " 0.1.0.3", "0.1..3", "2147483648.1.2.3", "0.1.0.4294967296",
        "0.1.0.３"}) {
    SCOPED_TRACE(version);
    EXPECT_FALSE(GetVelmrenReleaseVersionFromExecutablePath(
        InstalledExecutable(version)));
  }
}

TEST(VelmrenVersionInfoTest, RejectsOtherExecutableLayouts) {
  for (std::string_view relative_path :
       {"velmren.exe", "out/Release/velmren.exe",
        "versions/0.1.0.3/browser/velmren.exe",
        "versions/0.1.0.3/app/browser/chrome.exe",
        "versions/0.1.0.3/app/browser/velmren.exe.extra",
        "versions/0.1.0.3/app/delivery/Velmren.exe",
        "releases/0.1.0.3/app/browser/velmren.exe",
        "versions/0.1.0.3/app/browser/extra/velmren.exe",
        "versions/0.1.0.3/../0.1.0.4/app/browser/velmren.exe"}) {
    SCOPED_TRACE(relative_path);
    EXPECT_FALSE(
        GetVelmrenReleaseVersionFromExecutablePath(InstallationRoot().Append(
            base::FilePath::FromUTF8Unsafe(relative_path))));
  }
  EXPECT_FALSE(GetVelmrenReleaseVersionFromExecutablePath(base::FilePath(
      FILE_PATH_LITERAL("versions/0.1.0.3/app/browser/velmren.exe"))));
  EXPECT_FALSE(GetVelmrenReleaseVersionFromExecutablePath(
      InstalledExecutable("0.1.0.3").AsEndingWithSeparator()));
}

TEST(VelmrenVersionInfoTest, ReportsRunningReleaseIncludingRetainedVersions) {
  // No current.json or launcher metadata is consulted for either executable.
  for (std::string_view version : {"0.1.0.4", "0.1.0.3"}) {
    const base::ScopedPathOverride executable_override(
        base::FILE_EXE, InstalledExecutable(version), true);
    EXPECT_EQ(std::string(version), GetVelmrenReleaseVersion());
    EXPECT_EQ(version, GetVelmrenProductVersionForDisplay());
    const std::string displayed = GetVelmrenVersionNumberForDisplay();
    EXPECT_EQ(0u, displayed.find(std::string(version) + " Chromium: "));
    EXPECT_NE(std::string::npos,
              displayed.find(GetBraveChromiumVersionNumber()));
    EXPECT_NE(
        std::string::npos,
        displayed.find(
            "(Brave: " + GetBraveVersionWithoutChromiumMajorVersion() + ")"));
  }
}

TEST(VelmrenVersionInfoTest, DevelopmentBuildHasNoReleaseIdentity) {
  const base::ScopedPathOverride executable_override(
      base::FILE_EXE, InstallationRoot().AppendASCII("out/Release/velmren.exe"),
      true);
  EXPECT_FALSE(GetVelmrenReleaseVersion());
  EXPECT_EQ("Development build", GetVelmrenProductVersionForDisplay());
  EXPECT_EQ(0u, GetVelmrenVersionNumberForDisplay().find("Development build "));
}

}  // namespace
}  // namespace version_info
