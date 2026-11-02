/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/velmren_delivery_win.h"

#include <windows.h>

#include <shellapi.h>

#include <initializer_list>
#include <string>
#include <string_view>
#include <vector>

#include "base/compiler_specific.h"
#include "base/containers/span.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace velmren::delivery {

namespace {

class VelmrenDeliveryWinTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(temporary_.CreateUniqueTempDir());
    root_ = temporary_.GetPath().Append(FILE_PATH_LITERAL("My Installation"));
    ASSERT_TRUE(base::CreateDirectory(root_));
    for (const auto* name : {L".velmren-owner.json", L"installation.json",
                            L"Velmren.exe"}) {
      ASSERT_TRUE(base::WriteFile(root_.Append(name), "fixture"));
    }
  }

  base::FilePath Browser(std::wstring_view version = L"0.1.0.4") {
    const auto executable =
        root_.Append(FILE_PATH_LITERAL("versions"))
            .Append(version)
            .Append(FILE_PATH_LITERAL("app"))
            .Append(FILE_PATH_LITERAL("browser"))
            .Append(FILE_PATH_LITERAL("velmren.exe"));
    EXPECT_TRUE(base::CreateDirectory(executable.DirName()));
    EXPECT_TRUE(base::WriteFile(executable, "fixture"));
    return executable;
  }

  base::ScopedTempDir temporary_;
  base::FilePath root_;
};

TEST_F(VelmrenDeliveryWinTest, RequiresExactInstalledLayoutAndMarkers) {
  const auto browser = Browser();
  EXPECT_EQ(FindInstalledRoot(browser), root_);
  EXPECT_FALSE(FindInstalledRoot(root_.Append(FILE_PATH_LITERAL("Velmren.exe"))));
  EXPECT_FALSE(FindInstalledRoot(base::FilePath(
      FILE_PATH_LITERAL("versions/0.1.0.4/app/browser/velmren.exe"))));
  EXPECT_FALSE(FindInstalledRoot(
      root_.Append(FILE_PATH_LITERAL("versions/0.1.0.4/app/../browser/velmren.exe"))));
  for (const auto* version : {L"0.1.4", L"0.1.0.04", L"0.1.0.4.0",
                             L"-1.1.0.4", L"0.1.0.2147483648"}) {
    EXPECT_FALSE(FindInstalledRoot(Browser(version))) << version;
  }
  const auto marker = root_.Append(FILE_PATH_LITERAL("installation.json"));
  ASSERT_TRUE(base::DeleteFile(marker));
  EXPECT_FALSE(FindInstalledRoot(browser));
  ASSERT_TRUE(base::CreateDirectory(marker));
  EXPECT_FALSE(FindInstalledRoot(browser));
}

TEST_F(VelmrenDeliveryWinTest, PreservesActualProfileAndVerbArgumentOrder) {
  const auto profile = temporary_.GetPath()
                           .Append(FILE_PATH_LITERAL("Other User Data"))
                           .Append(FILE_PATH_LITERAL("Profile 2"));
  const auto command = MakeBrowserCommand(Browser(), profile, true, true);
  ASSERT_TRUE(command);
  EXPECT_EQ(command->GetProgram(), root_.Append(FILE_PATH_LITERAL("Velmren.exe")));

  int argc = 0;
  LPWSTR* argv = ::CommandLineToArgvW(command->GetCommandLineString().c_str(),
                                    &argc);
  ASSERT_NE(argv, nullptr);
  ASSERT_GT(argc, 0);
  // SAFETY: CommandLineToArgvW returns exactly argc pointers in this allocation.
  const auto arguments =
      UNSAFE_BUFFERS(base::span(argv, static_cast<size_t>(argc)));
  const std::vector<std::wstring> actual(arguments.begin(), arguments.end());
  ::LocalFree(argv);
  const std::vector<std::wstring> expected = {
      command->GetProgram().value(),
      L"launch",
      L"--root=" + root_.value(),
      L"--user-data-dir=" + profile.DirName().value(),
      L"--profile-directory=Profile 2",
      L"--incognito=true",
      L"--new-window=true",
  };
  EXPECT_EQ(actual, expected);
  EXPECT_FALSE(MakeBrowserCommand(Browser(), base::FilePath(L"Default")));
}

TEST_F(VelmrenDeliveryWinTest, DefaultCommandDoesNotAddOptionalModes) {
  const auto command = MakeBrowserCommand(
      Browser(), root_.Append(FILE_PATH_LITERAL("profile/Default")));
  ASSERT_TRUE(command);
  EXPECT_EQ(command->argv().size(), 5u);
  EXPECT_EQ(command->argv()[1], L"launch");
}

TEST(VelmrenDeliveryCommandTest, ExcludesAgentsHeadlessAndChildProcesses) {
  const base::FilePath executable(FILE_PATH_LITERAL("C:/fixture/velmren.exe"));
  EXPECT_TRUE(IsOrdinaryBrowserCommand(base::CommandLine(executable)));
  for (const auto* name : {"type", "headless", "velmren-agent-mode",
                          "enable-automation", "test-type"}) {
    base::CommandLine command(executable);
    command.AppendSwitchASCII(name, "test");
    EXPECT_FALSE(IsOrdinaryBrowserCommand(command)) << name;
  }
}

}  // namespace

}  // namespace velmren::delivery
