/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "chrome/browser/devtools/chrome_devtools_manager_delegate.h"

#include "base/command_line.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ui/base/base_window.h"

#if defined(USE_AURA)
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/compositor/compositor.h"
#include "ui/views/widget/widget.h"
#endif

#include <chrome/browser/devtools/chrome_devtools_manager_delegate.cc>

namespace {

#if defined(USE_AURA)
// Aura needs a compositor root even for offscreen pages. This widget creates
// that root without ever showing or activating its native top-level window.
class AgentTargetSurface final
    : public content::WebContentsUserData<AgentTargetSurface>,
      public content::WebContentsObserver {
 public:
  ~AgentTargetSurface() override { Detach(); }

  void Attach() {
    if (widget_) {
      return;
    }
    auto* contents = web_contents();
    widget_ = std::make_unique<views::Widget>();
    views::Widget::InitParams params(
        views::Widget::InitParams::CLIENT_OWNS_WIDGET,
        views::Widget::InitParams::TYPE_POPUP);
    params.name = "VelmrenAgentSurface";
    params.bounds = gfx::Rect(0, 0, 1280, 800);
    params.activatable = views::Widget::InitParams::Activatable::kNo;
    params.accept_events = false;
    params.opacity = views::Widget::InitParams::WindowOpacity::kOpaque;
    widget_->Init(std::move(params));
    auto* root = widget_->GetNativeWindow()->GetRootWindow();
    root->AddChild(contents->GetNativeView());
    contents->Resize(gfx::Rect(0, 0, 1280, 800));
    // The Aura ancestor must permit child layers to composite. This does not
    // show the widget's native top-level window; WebContents remains idle-hidden.
    contents->GetNativeView()->Show();
    // Scoped focus emulation and screenshots drive rendering only on demand.
    // Do not call Widget::Show(), activate the host, or expose a normal tab.
    root->GetHost()->compositor()->SetVisible(true);
    contents->WasHidden();
  }

  void Detach() {
    if (!widget_) {
      return;
    }
    if (auto* contents = web_contents()) {
      auto* view = contents->GetNativeView();
      auto* root = widget_->GetNativeWindow()->GetRootWindow();
      if (view->parent() == root) {
        root->RemoveChild(view);
      }
    }
    widget_.reset();
  }

  void WebContentsDestroyed() override { Detach(); }

 private:
  friend class content::WebContentsUserData<AgentTargetSurface>;
  explicit AgentTargetSurface(content::WebContents* contents)
      : content::WebContentsUserData<AgentTargetSurface>(*contents),
        content::WebContentsObserver(contents) {}

  std::unique_ptr<views::Widget> widget_;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(AgentTargetSurface);
#endif

}  // namespace

void ChromeDevToolsManagerDelegate::PrepareAgentTarget(
    content::WebContents* web_contents) {
  if (!base::CommandLine::ForCurrentProcess()->HasSwitch("velmren-agent-mode")) {
    return;
  }
#if defined(USE_AURA)
  AgentTargetSurface::GetOrCreateForWebContents(web_contents)->Attach();
#endif
}

void ChromeDevToolsManagerDelegate::ShowAgentTarget(
    std::unique_ptr<content::WebContents>& web_contents) {
  if (!base::CommandLine::ForCurrentProcess()->HasSwitch("velmren-agent-mode")) {
    return;
  }
  auto* profile = Profile::FromBrowserContext(web_contents->GetBrowserContext());
  if (GetBrowserWindowCreationStatusForProfile(*profile) !=
      BrowserWindowInterface::CreationStatus::kOk) {
    return;
  }

  // A handoff window belongs to exactly this context and should never restore
  // agent pages into the user's next browser session.
  BrowserWindowCreateParams params(profile, true);
  params.omit_from_session_restore = true;
  params.should_trigger_session_restore = false;
  auto* browser = CreateBrowserWindow(std::move(params));
  if (!browser) {
    return;
  }
#if defined(USE_AURA)
  if (auto* surface = AgentTargetSurface::FromWebContents(web_contents.get())) {
    surface->Detach();
  }
#endif
  web_contents->SetDelegate(nullptr);
  browser->GetTabStripModel()->InsertWebContentsAt(
      0, std::move(web_contents), AddTabTypes::ADD_ACTIVE);
  browser->GetWindow()->Show();
}

std::unique_ptr<content::WebContents>
ChromeDevToolsManagerDelegate::TakeAgentTarget(content::WebContents* source) {
  auto* browser =
      GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(source);
  if (!browser) {
    return nullptr;
  }
  auto* tab_strip = browser->GetTabStripModel();
  const int index = tab_strip->GetIndexOfWebContents(source);
  if (index == TabStripModel::kNoTab) {
    return nullptr;
  }
  if (tab_strip->count() == 1) {
    browser->GetWindow()->Hide();
  }
  // Detachment destroys the TabModel, not the WebContents or its document.
  // The normal empty-strip path closes a now-empty handoff window.
  auto contents = tab_strip->DetachWebContentsAtForInsertion(index);
  contents->SetDelegate(nullptr);
  contents->WasHidden();
  return contents;
}
