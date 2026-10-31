/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "content/browser/devtools/protocol/target_handler.h"

#include "base/command_line.h"
#include "content/public/common/content_switches.h"

// Pipe-only startup has no normal page targets when --no-startup-window is
// used, so RemoteDebuggingTargets() cannot detect that transport.
#define BRAVE_TARGET_HANDLER_CREATE_HIDDEN_TARGET                         \
  && !(base::CommandLine::ForCurrentProcess()->HasSwitch(                  \
           "velmren-agent-mode") &&                                      \
       base::CommandLine::ForCurrentProcess()->HasSwitch(                  \
           switches::kRemoteDebuggingPipe))

#include <content/browser/devtools/protocol/target_handler.cc>

#undef BRAVE_TARGET_HANDLER_CREATE_HIDDEN_TARGET

namespace content::protocol {

Response TargetHandler::SetTargetVisibility(const std::string& target_id,
                                          bool visible) {
  if (access_mode_ != AccessMode::kBrowser ||
      !root_session_->GetClient()->IsTrusted() ||
      !base::CommandLine::ForCurrentProcess()->HasSwitch(
          "velmren-agent-mode")) {
    return Response::ServerError("Agent target handoff is not enabled");
  }
  return hidden_target_manager_.SetTargetVisibility(target_id, visible);
}

}  // namespace content::protocol
