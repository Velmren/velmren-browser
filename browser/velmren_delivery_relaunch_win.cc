/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/velmren_delivery_win.h"

#include "base/base_paths.h"
#include "base/logging.h"
#include "base/path_service.h"
#include "base/process/launch.h"
#include "brave/browser/velmren_update_status.h"
#include "chrome/common/chrome_paths.h"
#include "chrome/common/chrome_switches.h"

namespace velmren::delivery {

// Called after Chromium has saved session state and completed normal shutdown.
// The launcher waits for this process to exit before activating an update.
bool TryRelaunchThroughDelivery(const base::CommandLine& relaunch_command,
                               bool force_breakaway_from_job) {
  const auto& current_command = *base::CommandLine::ForCurrentProcess();
  const auto* monitor = UpdateStatusMonitor::GetInstance();
  if (!IsOrdinaryBrowserCommand(current_command) ||
      current_command.HasSwitch(switches::kIsolated) || !monitor->supported() ||
      monitor->status().phase != UpdatePhase::kReady ||
      monitor->status().relaunch_blocked) {
    return false;
  }

  base::FilePath executable;
  if (!base::PathService::Get(base::FILE_EXE, &executable)) {
    return false;
  }
  base::FilePath user_data_dir;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &user_data_dir)) {
    user_data_dir = relaunch_command.GetSwitchValuePath(switches::kUserDataDir);
  }
  const auto command =
      MakeRelaunchCommand(executable, user_data_dir, relaunch_command,
                         base::GetCurrentProcId(), /*update_ready=*/true);
  if (!command) {
    return false;
  }

  base::LaunchOptions options;
  options.current_directory = command->GetProgram().DirName();
  options.start_hidden = true;
  options.feedback_cursor_off = true;
  options.grant_foreground_privilege = true;
  options.force_breakaway_from_job_ = force_breakaway_from_job;
  if (base::LaunchProcess(*command, options).IsValid()) {
    return true;
  }
  PLOG(WARNING) << "Could not start the Velmren update relauncher";
  return false;
}

}  // namespace velmren::delivery
