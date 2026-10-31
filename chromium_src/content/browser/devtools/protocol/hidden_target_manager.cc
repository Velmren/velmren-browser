/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "content/browser/devtools/protocol/hidden_target_manager.h"

#include "base/command_line.h"
#include "content/browser/devtools/devtools_manager.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_manager_delegate.h"
#include "content/public/browser/web_contents.h"

#define BRAVE_HIDDEN_TARGET_MANAGER_CLEAR ClearVisibleTargets();
#define BRAVE_HIDDEN_TARGET_MANAGER_CREATE_PARAMS                         \
  create_params.initially_hidden =                                       \
      base::CommandLine::ForCurrentProcess()->HasSwitch("velmren-agent-mode");
#define BRAVE_HIDDEN_TARGET_MANAGER_PREPARE_CONTENTS                    \
  if (base::CommandLine::ForCurrentProcess()->HasSwitch(                 \
          "velmren-agent-mode")) {                                     \
    if (auto* delegate = DevToolsManager::GetInstance()->delegate()) {  \
      delegate->PrepareAgentTarget(web_contents.get());                \
    }                                                                  \
  }

#include <content/browser/devtools/protocol/hidden_target_manager.cc>

#undef BRAVE_HIDDEN_TARGET_MANAGER_CREATE_PARAMS
#undef BRAVE_HIDDEN_TARGET_MANAGER_PREPARE_CONTENTS
#undef BRAVE_HIDDEN_TARGET_MANAGER_CLEAR

namespace content::protocol {

Response HiddenTargetManager::SetTargetVisibility(const std::string& target_id,
                                                bool visible) {
  auto host = DevToolsAgentHost::GetForId(target_id);
  WebContents* contents = host ? host->GetWebContents() : nullptr;
  if (!contents) {
    visible_web_contents_.erase(target_id);
    return Response::InvalidParams("No target with given id found");
  }
  auto hidden_it = hidden_web_contents_.find(contents);
  auto shown_it = visible_web_contents_.find(target_id);
  const bool is_hidden = hidden_it != hidden_web_contents_.end();
  const bool is_shown = shown_it != visible_web_contents_.end() &&
                        shown_it->second.get() == contents;
  if (!is_hidden && !is_shown) {
    return Response::InvalidParams(
        "Target is not a hidden target owned by this session");
  }
  if (visible == is_shown) {
    return Response::Success();
  }
  auto* delegate = DevToolsManager::GetInstance()->delegate();
  if (!delegate) {
    return Response::ServerError("Agent target handoff is not supported");
  }

  if (visible) {
    auto owned_contents = std::move(*hidden_it);
    hidden_web_contents_.erase(hidden_it);
    auto weak_contents = owned_contents->GetWeakPtr();
    delegate->ShowAgentTarget(owned_contents);
    if (owned_contents) {
      hidden_web_contents_.insert(std::move(owned_contents));
      return Response::ServerError("Unable to show agent target");
    }
    visible_web_contents_.emplace(target_id, std::move(weak_contents));
  } else {
    auto owned_contents = delegate->TakeAgentTarget(contents);
    if (!owned_contents) {
      return Response::ServerError("Unable to hide agent target");
    }
    visible_web_contents_.erase(shown_it);
    owned_contents->SetDelegate(this);
    delegate->PrepareAgentTarget(owned_contents.get());
    hidden_web_contents_.insert(std::move(owned_contents));
  }
  return Response::Success();
}

void HiddenTargetManager::ClearVisibleTargets() {
  if (visible_web_contents_.empty()) {
    return;
  }
  // Clear our bookkeeping before detaching: tab removal dispatches observers.
  auto visible_contents = std::move(visible_web_contents_);
  visible_web_contents_.clear();
  auto* delegate = DevToolsManager::GetInstance()->delegate();
  if (!delegate) {
    return;
  }
  for (const auto& [id, contents] : visible_contents) {
    if (contents) {
      auto owned_contents = delegate->TakeAgentTarget(contents.get());
    }
  }
}

}  // namespace content::protocol
