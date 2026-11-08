/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/webui/settings/velmren_updates_handler.h"

#include "base/functional/bind.h"
#include "base/values.h"
#include "brave/browser/velmren_update_status.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "content/public/browser/web_ui.h"

namespace {

base::DictValue StatusValue() {
  const auto* monitor = velmren::delivery::UpdateStatusMonitor::GetInstance();
  const auto& status = monitor->status();
  return base::DictValue()
      .Set("supported", monitor->supported())
      .Set("phase", velmren::delivery::UpdatePhaseName(status.phase))
      .Set("installedVersion", status.installed_version)
      .Set("availableVersion", status.available_version)
      .Set("errorCode", status.error_code)
      .Set("lastChecked",
           status.last_checked_at.is_null()
               ? 0.0
               : status.last_checked_at
                     .InMillisecondsFSinceUnixEpochIgnoringNull())
      .Set("relaunchBlocked", status.relaunch_blocked);
}

}  // namespace

VelmrenUpdatesHandler::VelmrenUpdatesHandler() = default;
VelmrenUpdatesHandler::~VelmrenUpdatesHandler() = default;

void VelmrenUpdatesHandler::RegisterMessages() {
  web_ui()->RegisterMessageCallback(
      "getVelmrenUpdateStatus",
      base::BindRepeating(&VelmrenUpdatesHandler::GetStatus,
                          base::Unretained(this)));
  web_ui()->RegisterMessageCallback(
      "checkVelmrenUpdates",
      base::BindRepeating(&VelmrenUpdatesHandler::CheckNow,
                          base::Unretained(this)));
  web_ui()->RegisterMessageCallback(
      "relaunchVelmrenForUpdate",
      base::BindRepeating(&VelmrenUpdatesHandler::Relaunch,
                          base::Unretained(this)));
}

void VelmrenUpdatesHandler::OnJavascriptAllowed() {
  auto* monitor = velmren::delivery::UpdateStatusMonitor::GetInstance();
  subscription_ = monitor->AddObserver(base::BindRepeating(
      &VelmrenUpdatesHandler::OnStatusChanged, base::Unretained(this)));
  monitor->Refresh();
}

void VelmrenUpdatesHandler::OnJavascriptDisallowed() {
  subscription_ = {};
}

void VelmrenUpdatesHandler::GetStatus(const base::ListValue& args) {
  if (args.size() != 1 || !args[0].is_string()) {
    return;
  }
  AllowJavascript();
  ResolveJavascriptCallback(args[0], StatusValue());
}

void VelmrenUpdatesHandler::CheckNow(const base::ListValue& args) {
  if (!args.empty()) {
    return;
  }
  AllowJavascript();
  velmren::delivery::UpdateStatusMonitor::GetInstance()->CheckNow();
}

void VelmrenUpdatesHandler::Relaunch(const base::ListValue& args) {
  if (!args.empty()) {
    return;
  }
  AllowJavascript();
  auto* monitor = velmren::delivery::UpdateStatusMonitor::GetInstance();
  if (monitor->status().phase == velmren::delivery::UpdatePhase::kReady &&
      !monitor->status().relaunch_blocked) {
    // Standard shutdown preserves sessions and honors beforeunload. The
    // Windows relaunch hook enters the stable signed delivery launcher.
    chrome::AttemptRestart();
  }
}

void VelmrenUpdatesHandler::OnStatusChanged() {
  if (IsJavascriptAllowed()) {
    FireWebUIListener("velmren-update-status-changed", StatusValue());
  }
}
