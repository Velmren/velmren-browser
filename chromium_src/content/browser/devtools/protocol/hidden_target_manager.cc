/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "content/browser/devtools/protocol/hidden_target_manager.h"

#include <memory>
#include <string>
#include <utility>

#include "base/command_line.h"
#include "base/memory/raw_ref.h"
#include "content/browser/devtools/devtools_manager.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_manager_delegate.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"

namespace content::protocol {

// The observer survives transfers to a tab strip, whose delegate handles new
// windows while the human owns the page.
class HiddenTargetManager::AgentContentsObserver final
    : public WebContentsObserver {
 public:
  AgentContentsObserver(HiddenTargetManager& owner, WebContents* contents)
      : WebContentsObserver(contents),
        token_(contents->GetUniqueToken()),
        owner_(owner) {}

  void DidOpenRequestedURL(WebContents* new_contents,
                           RenderFrameHost* source_render_frame_host,
                           const GURL& url,
                           const Referrer& referrer,
                           WindowOpenDisposition disposition,
                           ui::PageTransition transition,
                           bool started_from_context_menu,
                           bool renderer_initiated) override {
    owner_->ObserveAgentPopup(web_contents(), new_contents);
  }

  void WebContentsDestroyed() override {
    // As in WebContentsImpl::WebContentsDestructionObserver, the owner removes
    // this observer during the callback. Copy the key before releasing it.
    const WebContents::UniqueToken token = token_;
    owner_->AgentContentsDestroyed(token);
  }

 private:
  const WebContents::UniqueToken token_;
  const raw_ref<HiddenTargetManager> owner_;
};

}  // namespace content::protocol

#define BRAVE_HIDDEN_TARGET_MANAGER_CLEAR \
  agent_contents_observers_.clear();      \
  ClearVisibleTargets();
#define BRAVE_HIDDEN_TARGET_MANAGER_CREATE_PARAMS \
  create_params.initially_hidden =                \
      base::CommandLine::ForCurrentProcess()->HasSwitch("velmren-agent-mode");
#define BRAVE_HIDDEN_TARGET_MANAGER_PREPARE_CONTENTS                   \
  if (base::CommandLine::ForCurrentProcess()->HasSwitch(               \
          "velmren-agent-mode")) {                                     \
    ObserveAgentContents(web_contents.get());                          \
    if (auto* delegate = DevToolsManager::GetInstance()->delegate()) { \
      delegate->PrepareAgentTarget(web_contents.get());                \
    }                                                                  \
  }

#include <content/browser/devtools/protocol/hidden_target_manager.cc>

#undef BRAVE_HIDDEN_TARGET_MANAGER_CREATE_PARAMS
#undef BRAVE_HIDDEN_TARGET_MANAGER_PREPARE_CONTENTS
#undef BRAVE_HIDDEN_TARGET_MANAGER_CLEAR

namespace content::protocol {

void HiddenTargetManager::ObserveAgentContents(WebContents* contents) {
  // Popup lineage is reported before its renderer frame is initialized.
  // Creating a DevTools host here would auto-attach before it can bind a
  // channel.
  const auto token = contents->GetUniqueToken();
  if (!agent_contents_observers_.contains(token)) {
    agent_contents_observers_.emplace(
        token, std::make_unique<AgentContentsObserver>(*this, contents));
  }
}

void HiddenTargetManager::ObserveAgentPopup(WebContents* source,
                                            WebContents* contents) {
  if (!base::CommandLine::ForCurrentProcess()->HasSwitch(
          "velmren-agent-mode") ||
      !source || !contents || source == contents ||
      source->GetBrowserContext() != contents->GetBrowserContext() ||
      contents->GetFirstWebContentsInLiveOriginalOpenerChain() != source) {
    return;
  }
  if (!agent_contents_observers_.contains(source->GetUniqueToken())) {
    return;
  }

  ObserveAgentContents(contents);
  if (!hidden_web_contents_.contains(source)) {
    // A shown parent's Browser delegate owns the popup. Record native lineage,
    // including noopener, so it can be returned to this session later.
    visible_web_contents_.emplace(contents->GetUniqueToken(),
                                  contents->GetWeakPtr());
  }
}

void HiddenTargetManager::AgentContentsDestroyed(
    const WebContents::UniqueToken& token) {
  visible_web_contents_.erase(token);
  agent_contents_observers_.erase(token);
}

WebContents* HiddenTargetManager::AddNewContents(
    WebContents* source,
    std::unique_ptr<WebContents> new_contents,
    const GURL& target_url,
    WindowOpenDisposition disposition,
    const blink::mojom::WindowFeatures& window_features,
    bool user_gesture,
    bool* was_blocked) {
  if (!base::CommandLine::ForCurrentProcess()->HasSwitch(
          "velmren-agent-mode") ||
      !source || !hidden_web_contents_.contains(source) || !new_contents ||
      source->GetBrowserContext() != new_contents->GetBrowserContext() ||
      new_contents->GetFirstWebContentsInLiveOriginalOpenerChain() != source) {
    return WebContentsDelegate::AddNewContents(
        source, std::move(new_contents), target_url, disposition,
        window_features, user_gesture, was_blocked);
  }

  auto* contents = new_contents.get();
  ObserveAgentContents(contents);
  visible_web_contents_.erase(contents->GetUniqueToken());
  contents->SetDelegate(this);
  if (auto* delegate = DevToolsManager::GetInstance()->delegate()) {
    delegate->PrepareAgentTarget(contents);
  }
  contents->WasHidden();
  hidden_web_contents_.insert(std::move(new_contents));
  if (was_blocked) {
    *was_blocked = false;
  }
  return contents;
}

Response HiddenTargetManager::SetTargetVisibility(const std::string& target_id,
                                                  bool visible) {
  auto host = DevToolsAgentHost::GetForId(target_id);
  WebContents* contents = host ? host->GetWebContents() : nullptr;
  if (!contents) {
    return Response::InvalidParams("No target with given id found");
  }
  auto hidden_it = hidden_web_contents_.find(contents);
  const auto token = contents->GetUniqueToken();
  auto shown_it = visible_web_contents_.find(token);
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
    visible_web_contents_.emplace(token, std::move(weak_contents));
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
