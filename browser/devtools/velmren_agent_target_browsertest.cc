/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/memory/weak_ptr.h"
#include "base/test/run_until.h"
#include "base/test/scoped_command_line.h"
#include "base/values.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "chrome/test/base/in_process_browser_test.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/visibility.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/test/browser_test.h"
#include "content/public/test/browser_test_utils.h"
#include "content/public/test/test_devtools_protocol_client.h"
#include "net/test/embedded_test_server/embedded_test_server.h"
#include "third_party/blink/public/mojom/window_features/window_features.mojom.h"
#include "ui/base/base_window.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

#if defined(USE_AURA)
#include "ui/aura/window.h"
#include "ui/views/widget/widget.h"
#endif

// These tests inspect native tab ownership and WebContents identity, which
// cannot be asserted by content_shell inspector-protocol tests.
class VelmrenAgentTargetBrowserTest
    : public InProcessBrowserTest,
      public content::TestDevToolsProtocolClient {
 public:
  void SetUpCommandLine(base::CommandLine* command_line) override {
    InProcessBrowserTest::SetUpCommandLine(command_line);
    command_line->AppendSwitch("velmren-agent-mode");
  }

  void SetUpOnMainThread() override {
    InProcessBrowserTest::SetUpOnMainThread();
    ASSERT_TRUE(embedded_test_server()->Start());
    AttachToBrowserTarget();
  }

  void TearDownOnMainThread() override {
    DetachProtocolClient();
    InProcessBrowserTest::TearDownOnMainThread();
  }

 protected:
  void DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                               base::span<const uint8_t> message) override {
    if (observed_response_id_) {
      auto response = base::JSONReader::ReadDict(
          std::string_view(reinterpret_cast<const char*>(message.data()),
                           message.size()),
          base::JSON_PARSE_CHROMIUM_EXTENSIONS);
      if (response && response->FindInt("id") == observed_response_id_) {
        observed_response_ = std::move(*response);
      }
    }
    content::TestDevToolsProtocolClient::DispatchProtocolMessage(agent_host,
                                                                 message);
  }

  std::optional<int> observed_response_id_;
  std::optional<base::DictValue> observed_response_;

  std::string CreateHiddenTarget(const std::string& context_id = {}) {
    auto params =
        base::DictValue()
            .Set("url", embedded_test_server()->GetURL("/empty.html").spec())
            .Set("hidden", true)
            .Set("forTab", false)
            .Set("newWindow", false)
            .Set("background", true);
    if (!context_id.empty()) {
      params.Set("browserContextId", context_id);
    }
    const auto* response =
        SendCommandSync("Target.createTarget", std::move(params));
    if (!response || !response->FindString("targetId")) {
      ADD_FAILURE() << "Could not create hidden target";
      return {};
    }
    return *response->FindString("targetId");
  }

  const base::DictValue* SetVisibility(const std::string& id, bool visible) {
    return SendCommandSync(
        "Target.setTargetVisibility",
        base::DictValue().Set("targetId", id).Set("visible", visible));
  }

  content::WebContents* ContentsFor(const std::string& id) {
    auto host = content::DevToolsAgentHost::GetForId(id);
    return host ? host->GetWebContents() : nullptr;
  }

  content::WebContents* OpenPopup(content::WebContents* source,
                                  const std::string& features = "popup") {
    content::WebContentsAddedObserver popup_added;
    // EvalJsRunner supplies user activation only in the main world. A shown
    // parent's popup blocker requires that activation for this user action.
    if (!content::ExecJs(
            source,
            content::JsReplace(
                "window.agentPopup = window.open($1, '_blank', $2)",
                embedded_test_server()->GetURL("/empty.html"), features))) {
      ADD_FAILURE() << "Could not open popup";
      return nullptr;
    }
    auto* popup = popup_added.GetWebContents();
    if (!popup || !content::WaitForLoadStop(popup)) {
      ADD_FAILURE() << "Popup did not finish loading";
      return nullptr;
    }
    return popup;
  }
};

IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest,
                       RoundTripPreservesDocumentAndForm) {
  auto* browsers = GlobalBrowserCollection::GetInstance();
  const size_t original_windows = browsers->GetSize();
  const int original_tabs = browser()->tab_strip_model()->count();
  auto* original_active_tab =
      browser()->tab_strip_model()->GetActiveWebContents();
  const std::string id = CreateHiddenTarget();
  auto* contents = ContentsFor(id);
  ASSERT_TRUE(contents);
  ASSERT_TRUE(content::WaitForLoadStop(contents));
  const auto frame_id = contents->GetPrimaryMainFrame()->GetGlobalId();
  EXPECT_EQ(original_windows, browsers->GetSize());
  EXPECT_EQ(original_tabs, browser()->tab_strip_model()->count());
  EXPECT_EQ(original_active_tab,
            browser()->tab_strip_model()->GetActiveWebContents());
  EXPECT_FALSE(browsers->FindBrowserWithTab(contents));
  EXPECT_EQ(content::Visibility::HIDDEN, contents->GetVisibility());

  ASSERT_TRUE(content::ExecJs(contents, R"(
    document.body.innerHTML = '<input id="draft">';
    document.querySelector('#draft').value = 'agent draft';
    window.documentMarker = {value: 'same document'};
    sessionStorage.setItem('handoff', 'retained');
  )",
                              content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                              ISOLATED_WORLD_ID_BRAVE_INTERNAL));
  ASSERT_TRUE(SetVisibility(id, true));
  EXPECT_EQ(contents, ContentsFor(id));
  EXPECT_EQ(frame_id, contents->GetPrimaryMainFrame()->GetGlobalId());
  auto* handoff_window = browsers->FindBrowserWithTab(contents);
  ASSERT_TRUE(handoff_window);
  EXPECT_EQ(browser()->GetProfile(), handoff_window->GetProfile());
  EXPECT_TRUE(handoff_window->GetWindow()->IsVisible());
  EXPECT_EQ(original_windows + 1, browsers->GetSize());
  EXPECT_EQ(original_tabs, browser()->tab_strip_model()->count());
  ASSERT_TRUE(content::ExecJs(
      contents, "document.querySelector('#draft').value = 'human edit'",
      content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
      ISOLATED_WORLD_ID_BRAVE_INTERNAL));

  ASSERT_TRUE(SetVisibility(id, false));
  EXPECT_EQ(contents, ContentsFor(id));
  EXPECT_EQ(frame_id, contents->GetPrimaryMainFrame()->GetGlobalId());
  EXPECT_FALSE(browsers->FindBrowserWithTab(contents));
  EXPECT_EQ(content::Visibility::HIDDEN, contents->GetVisibility());
  EXPECT_EQ("human edit|same document|retained",
            content::EvalJs(contents, R"(
              [document.querySelector('#draft').value,
               window.documentMarker.value,
               sessionStorage.getItem('handoff')].join('|')
            )",
                            content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                            ISOLATED_WORLD_ID_BRAVE_INTERNAL));
  ASSERT_TRUE(base::test::RunUntil(
      [&]() { return browsers->GetSize() == original_windows; }));
  // Repeated requests are idempotent and a second transfer still uses the page.
  ASSERT_TRUE(SetVisibility(id, false));
  ASSERT_TRUE(SetVisibility(id, true));
  ASSERT_TRUE(SetVisibility(id, true));
  EXPECT_EQ(contents, ContentsFor(id));
  EXPECT_EQ(frame_id, contents->GetPrimaryMainFrame()->GetGlobalId());
}

IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest,
                       RejectsOrdinaryAndOtherSessionTargets) {
  auto* ordinary_contents =
      browser()->tab_strip_model()->GetActiveWebContents();
  const std::string ordinary_id =
      content::DevToolsAgentHost::GetOrCreateFor(ordinary_contents)->GetId();
  EXPECT_FALSE(SetVisibility(ordinary_id, false));
  ASSERT_TRUE(error());
  EXPECT_EQ(-32602, error()->FindInt("code"));
  EXPECT_FALSE(SetVisibility("missing-target", true));
  ASSERT_TRUE(error());
  EXPECT_EQ(-32602, error()->FindInt("code"));

  const std::string id = CreateHiddenTarget();
  ASSERT_TRUE(ContentsFor(id));
  content::TestDevToolsProtocolClient other_session;
  other_session.AttachToBrowserTarget();
  EXPECT_FALSE(other_session.SendCommandSync(
      "Target.setTargetVisibility",
      base::DictValue().Set("targetId", id).Set("visible", true)));
  ASSERT_TRUE(SetVisibility(id, true));
  EXPECT_FALSE(other_session.SendCommandSync(
      "Target.setTargetVisibility",
      base::DictValue().Set("targetId", id).Set("visible", false)));
  other_session.DetachProtocolClient();
  EXPECT_TRUE(ContentsFor(id));
}

IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest,
                       HiddenNestedPopupsPreserveOpenerAndHandoff) {
  auto* browsers = GlobalBrowserCollection::GetInstance();
  const size_t original_windows = browsers->GetSize();
  auto* original_active_tab =
      browser()->tab_strip_model()->GetActiveWebContents();
  const std::string root_id = CreateHiddenTarget();
  auto* root = ContentsFor(root_id);
  ASSERT_TRUE(root);
  ASSERT_TRUE(content::WaitForLoadStop(root));
  ASSERT_TRUE(content::ExecJs(root, R"(
    document.body.innerHTML = '<input id="draft" value="root draft">';
    sessionStorage.setItem('popup', 'inherited');
    document.cookie = 'agent_popup=shared; SameSite=Lax';
    window.popupMessage = new Promise(resolve => {
      addEventListener('message', event => resolve(event.data), {once: true});
    });
    void 0;
  )",
                              content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                              ISOLATED_WORLD_ID_BRAVE_INTERNAL));

  auto* popup = OpenPopup(root);
  ASSERT_TRUE(popup);
  auto* nested = OpenPopup(popup);
  ASSERT_TRUE(nested);
  auto* no_opener = OpenPopup(root, "popup,noopener");
  ASSERT_TRUE(no_opener);
  EXPECT_EQ(root->GetBrowserContext(), popup->GetBrowserContext());
  EXPECT_EQ(root->GetBrowserContext(), nested->GetBrowserContext());
  EXPECT_EQ(root, popup->GetFirstWebContentsInLiveOriginalOpenerChain());
  EXPECT_EQ(popup, nested->GetFirstWebContentsInLiveOriginalOpenerChain());
  EXPECT_EQ(root, no_opener->GetFirstWebContentsInLiveOriginalOpenerChain());
  EXPECT_FALSE(no_opener->HasOpener());
  EXPECT_EQ(original_windows, browsers->GetSize());
  EXPECT_EQ(original_active_tab,
            browser()->tab_strip_model()->GetActiveWebContents());
  EXPECT_FALSE(browsers->FindBrowserWithTab(popup));
  EXPECT_FALSE(browsers->FindBrowserWithTab(nested));
  EXPECT_FALSE(browsers->FindBrowserWithTab(no_opener));
  EXPECT_EQ(content::Visibility::HIDDEN, popup->GetVisibility());
  EXPECT_EQ(content::Visibility::HIDDEN, nested->GetVisibility());
  EXPECT_EQ(content::Visibility::HIDDEN, no_opener->GetVisibility());
  EXPECT_EQ("root draft|inherited|true",
            content::EvalJs(popup, R"(
              [window.opener.document.querySelector('#draft').value,
               sessionStorage.getItem('popup'),
               document.cookie.includes('agent_popup=shared')].join('|')
            )",
                            content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                            ISOLATED_WORLD_ID_BRAVE_INTERNAL));
  ASSERT_TRUE(content::ExecJs(popup, R"(
    window.opener.postMessage('popup callback', location.origin);
    document.body.innerHTML = '<input id="draft" value="popup draft">';
    sessionStorage.setItem('popup', 'popup state');
  )",
                              content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                              ISOLATED_WORLD_ID_BRAVE_INTERNAL));
  EXPECT_EQ("popup callback",
            content::EvalJs(root, "window.popupMessage",
                            content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                            ISOLATED_WORLD_ID_BRAVE_INTERNAL));

  const std::string popup_id =
      content::DevToolsAgentHost::GetOrCreateFor(popup)->GetId();
  const auto popup_frame_id = popup->GetPrimaryMainFrame()->GetGlobalId();
  ASSERT_TRUE(SetVisibility(popup_id, true));
  ASSERT_TRUE(SetVisibility(popup_id, false));
  EXPECT_EQ(popup, ContentsFor(popup_id));
  EXPECT_EQ(popup_frame_id, popup->GetPrimaryMainFrame()->GetGlobalId());
  EXPECT_EQ("popup draft|popup state|true",
            content::EvalJs(popup, R"(
              [document.querySelector('#draft').value,
               sessionStorage.getItem('popup'), !!window.opener].join('|')
            )",
                            content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                            ISOLATED_WORLD_ID_BRAVE_INTERNAL));

  auto popup_weak = popup->GetWeakPtr();
  auto nested_weak = nested->GetWeakPtr();
  auto no_opener_weak = no_opener->GetWeakPtr();
  ASSERT_TRUE(content::ExecJs(popup, "window.close()",
                              content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                              ISOLATED_WORLD_ID_BRAVE_INTERNAL));
  ASSERT_TRUE(base::test::RunUntil([&]() { return !popup_weak; }));
  EXPECT_TRUE(nested_weak);
  EXPECT_TRUE(ContentsFor(root_id));
  DetachProtocolClient();
  EXPECT_FALSE(nested_weak);
  EXPECT_FALSE(no_opener_weak);
}

IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest,
                       ShownParentNoOpenerPopupCanReturnToAgent) {
  const std::string root_id = CreateHiddenTarget();
  auto* root = ContentsFor(root_id);
  ASSERT_TRUE(root);
  ASSERT_TRUE(content::WaitForLoadStop(root));
  ASSERT_TRUE(SetVisibility(root_id, true));
  auto* popup = OpenPopup(root, "popup,noopener");
  ASSERT_TRUE(popup);
  EXPECT_EQ(root->GetBrowserContext(), popup->GetBrowserContext());
  EXPECT_EQ(root, popup->GetFirstWebContentsInLiveOriginalOpenerChain());
  EXPECT_FALSE(popup->HasOpener());
  EXPECT_EQ(true, content::EvalJs(popup, "window.opener === null",
                                  content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
                                  ISOLATED_WORLD_ID_BRAVE_INTERNAL));
  ASSERT_TRUE(
      GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(popup));
  const std::string popup_id =
      content::DevToolsAgentHost::GetOrCreateFor(popup)->GetId();
  const auto frame_id = popup->GetPrimaryMainFrame()->GetGlobalId();
  ASSERT_TRUE(SetVisibility(popup_id, false));
  EXPECT_EQ(popup, ContentsFor(popup_id));
  EXPECT_EQ(frame_id, popup->GetPrimaryMainFrame()->GetGlobalId());
  EXPECT_EQ(content::Visibility::HIDDEN, popup->GetVisibility());
  ASSERT_TRUE(SetVisibility(popup_id, true));
  auto root_weak = root->GetWeakPtr();
  auto popup_weak = popup->GetWeakPtr();
  DetachProtocolClient();
  EXPECT_FALSE(root_weak);
  EXPECT_FALSE(popup_weak);
}

IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest,
                       FivePopupContextsRemainIsolatedAndSessionOwned) {
  std::vector<std::string> roots;
  std::vector<std::string> popups;
  std::vector<base::WeakPtr<content::WebContents>> popup_contents;
  for (int i = 0; i < 5; ++i) {
    const auto* response =
        SendCommandSync("Target.createBrowserContext",
                        base::DictValue().Set("disposeOnDetach", true));
    ASSERT_TRUE(response);
    const std::string* context_id = response->FindString("browserContextId");
    ASSERT_TRUE(context_id);
    const std::string root_id = CreateHiddenTarget(*context_id);
    auto* root = ContentsFor(root_id);
    ASSERT_TRUE(root);
    ASSERT_TRUE(content::WaitForLoadStop(root));
    auto* popup = OpenPopup(root);
    ASSERT_TRUE(popup);
    for (const std::string& other_id : roots) {
      EXPECT_NE(ContentsFor(other_id)->GetBrowserContext(),
                popup->GetBrowserContext());
    }
    EXPECT_EQ(root->GetBrowserContext(), popup->GetBrowserContext());
    roots.push_back(root_id);
    popups.push_back(
        content::DevToolsAgentHost::GetOrCreateFor(popup)->GetId());
    popup_contents.push_back(popup->GetWeakPtr());
  }

  content::TestDevToolsProtocolClient other_session;
  other_session.AttachToBrowserTarget();
  for (const std::string& popup_id : popups) {
    EXPECT_FALSE(other_session.SendCommandSync(
        "Target.setTargetVisibility",
        base::DictValue().Set("targetId", popup_id).Set("visible", true)));
    ASSERT_TRUE(SetVisibility(popup_id, true));
    EXPECT_FALSE(other_session.SendCommandSync(
        "Target.setTargetVisibility",
        base::DictValue().Set("targetId", popup_id).Set("visible", false)));
    ASSERT_TRUE(SetVisibility(popup_id, false));
  }
  other_session.DetachProtocolClient();
  ASSERT_TRUE(SendCommandSync(
      "Target.closeTarget", base::DictValue().Set("targetId", popups.front())));
  ASSERT_TRUE(base::test::RunUntil([&]() { return !popup_contents.front(); }));
  for (size_t i = 1; i < popup_contents.size(); ++i) {
    EXPECT_TRUE(popup_contents[i]);
    EXPECT_TRUE(ContentsFor(roots[i]));
  }
  DetachProtocolClient();
  for (const auto& contents : popup_contents) {
    EXPECT_FALSE(contents);
  }
}

IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest,
                       AutoAttachedPopupsResumeWithInterception) {
  const std::string root_id = CreateHiddenTarget();
  auto* root = ContentsFor(root_id);
  ASSERT_TRUE(root);
  ASSERT_TRUE(content::WaitForLoadStop(root));
  const auto* response = SendCommandSync(
      "Target.attachToTarget",
      base::DictValue().Set("targetId", root_id).Set("flatten", true));
  ASSERT_TRUE(response);
  ASSERT_TRUE(response->FindString("sessionId"));
  const std::string root_session = *response->FindString("sessionId");
  const auto auto_attach_params = []() {
    return base::DictValue()
        .Set("autoAttach", true)
        .Set("waitForDebuggerOnStart", true)
        .Set("flatten", true)
        .Set("filter",
             base::ListValue()
                 .Append(base::DictValue()
                             .Set("type", "browser")
                             .Set("exclude", true))
                 .Append(
                     base::DictValue().Set("type", "tab").Set("exclude", true))
                 .Append(base::DictValue()));
  };
  ASSERT_TRUE(SendCommandSync("Target.setAutoAttach", auto_attach_params()));

  int resume_command_id = 1000;
  for (bool shown : {false, true}) {
    ASSERT_TRUE(SetVisibility(root_id, shown));
    for (const char* features : {"popup", "popup,noopener"}) {
      SCOPED_TRACE(testing::Message()
                   << "shown=" << shown << ", features=" << features);
      const GURL popup_url = embedded_test_server()->GetURL("/title1.html");
      ClearNotifications();
      // window.open may wait for the new renderer's debugger. Resume it through
      // its auto-attached session, as in target-setAutoAttach-windowOpen.js.
      SendSessionCommand(
          "Runtime.evaluate",
          base::DictValue()
              .Set("expression",
                   content::JsReplace("window.open($1, '_blank', $2); void 0;",
                                      popup_url, features))
              .Set("userGesture", true),
          root_session, false);
      auto attached = WaitForMatchingNotification(
          "Target.attachedToTarget",
          base::BindRepeating(
              [](const std::string& opener_id, const base::DictValue& params) {
                const auto* opener =
                    params.FindStringByDottedPath("targetInfo.openerId");
                return opener && *opener == opener_id;
              },
              root_id));
      EXPECT_EQ(true, attached.FindBool("waitingForDebugger"));
      const auto* session = attached.FindString("sessionId");
      const auto* id = attached.FindStringByDottedPath("targetInfo.targetId");
      ASSERT_TRUE(session);
      ASSERT_TRUE(id);
      auto* popup = ContentsFor(*id);
      ASSERT_TRUE(popup);
      auto popup_weak = popup->GetWeakPtr();

      ASSERT_TRUE(SendSessionCommand(
          "Fetch.enable",
          base::DictValue().Set("patterns",
                                base::ListValue().Append(
                                    base::DictValue().Set("urlPattern", "*"))),
          *session, true));
      ASSERT_TRUE(SendSessionCommand("Target.setAutoAttach",
                                     auto_attach_params(), *session, true));
      // A noopener popup may need its intercepted navigation to create the
      // renderer that acknowledges resume. Service that request before waiting
      // for the reply, while retaining the reply's explicit success check.
      SetProtocolCommandId(resume_command_id);
      observed_response_id_ = resume_command_id;
      observed_response_.reset();
      resume_command_id += 1000;
      SendSessionCommand("Runtime.runIfWaitingForDebugger", base::DictValue(),
                         *session, false);
      auto paused = WaitForNotification("Fetch.requestPaused", true);
      ASSERT_TRUE(paused.FindString("requestId"));
      ASSERT_TRUE(paused.FindStringByDottedPath("request.url"));
      EXPECT_EQ(popup_url.spec(),
                *paused.FindStringByDottedPath("request.url"));
      EXPECT_NE(popup_url, popup->GetLastCommittedURL());
      ASSERT_TRUE(SendSessionCommand(
          "Fetch.continueRequest",
          base::DictValue().Set("requestId", *paused.FindString("requestId")),
          *session, true));
      ASSERT_TRUE(content::WaitForLoadStop(popup));
      ASSERT_TRUE(base::test::RunUntil(
          [&]() { return observed_response_.has_value(); }));
      EXPECT_TRUE(observed_response_->FindDict("result"));
      EXPECT_FALSE(observed_response_->FindDict("error"));
      observed_response_id_.reset();
      EXPECT_EQ(popup_url, popup->GetLastCommittedURL());
      EXPECT_EQ(shown,
                GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(
                    popup) != nullptr);
      ASSERT_TRUE(SetVisibility(*id, false));
      EXPECT_EQ(popup, ContentsFor(*id));
      ASSERT_TRUE(SendCommandSync("Target.closeTarget",
                                  base::DictValue().Set("targetId", *id)));
      ASSERT_TRUE(base::test::RunUntil([&]() { return !popup_weak; }));
    }
  }
}

IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest,
                       PopupCaptureRequiresAgentModeAndNativeLineage) {
  const std::string root_id = CreateHiddenTarget();
  auto* root = ContentsFor(root_id);
  ASSERT_TRUE(root);
  ASSERT_TRUE(content::WaitForLoadStop(root));
  const auto add_contents =
      [&](std::unique_ptr<content::WebContents> contents) {
        return root->GetDelegate()->AddNewContents(
            root, std::move(contents), GURL("about:blank"),
            WindowOpenDisposition::NEW_POPUP, blink::mojom::WindowFeatures(),
            true, nullptr);
      };
  auto unrelated = content::WebContents::Create(
      content::WebContents::CreateParams(root->GetBrowserContext()));
  auto unrelated_weak = unrelated->GetWeakPtr();
  EXPECT_FALSE(add_contents(std::move(unrelated)));
  EXPECT_FALSE(unrelated_weak);

  content::WebContents::CreateParams params(root->GetBrowserContext());
  params.opener_id = root->GetPrimaryMainFrame()->GetGlobalId();
  auto related = content::WebContents::Create(params);
  ASSERT_EQ(root, related->GetFirstWebContentsInLiveOriginalOpenerChain());
  auto related_weak = related->GetWeakPtr();
  base::test::ScopedCommandLine command_line;
  command_line.GetProcessCommandLine()->RemoveSwitch("velmren-agent-mode");
  EXPECT_FALSE(add_contents(std::move(related)));
  EXPECT_FALSE(related_weak);
}

IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest,
                       SessionDisconnectClosesHiddenAndShownTargets) {
  auto* browsers = GlobalBrowserCollection::GetInstance();
  const size_t original_windows = browsers->GetSize();
  const std::string hidden_id = CreateHiddenTarget();
  const std::string shown_id = CreateHiddenTarget();
  ASSERT_TRUE(ContentsFor(hidden_id));
  ASSERT_TRUE(ContentsFor(shown_id));
  auto hidden = ContentsFor(hidden_id)->GetWeakPtr();
  auto shown = ContentsFor(shown_id)->GetWeakPtr();
  ASSERT_TRUE(SetVisibility(shown_id, true));
  DetachProtocolClient();
  EXPECT_FALSE(hidden);
  EXPECT_FALSE(shown);
  ASSERT_TRUE(base::test::RunUntil(
      [&]() { return browsers->GetSize() == original_windows; }));
}

IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest, HumanCanCloseHandoffTab) {
  const std::string id = CreateHiddenTarget();
  auto* contents = ContentsFor(id);
  ASSERT_TRUE(contents);
  auto weak_contents = contents->GetWeakPtr();
  ASSERT_TRUE(SetVisibility(id, true));
  auto* handoff =
      GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents);
  ASSERT_TRUE(handoff);
  handoff->GetTabStripModel()->CloseWebContents(contents,
                                                TabCloseTypes::CLOSE_NONE);
  ASSERT_TRUE(base::test::RunUntil([&]() { return !weak_contents; }));
  EXPECT_FALSE(SetVisibility(id, false));
  ASSERT_TRUE(error());
  EXPECT_EQ(-32602, error()->FindInt("code"));
}

#if defined(USE_AURA)
IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest,
                       SurfaceCanCloseBeforeHiddenTarget) {
  const std::string id = CreateHiddenTarget();
  auto* contents = ContentsFor(id);
  ASSERT_TRUE(contents);
  ASSERT_TRUE(content::WaitForLoadStop(contents));
  auto contents_weak = contents->GetWeakPtr();
  auto* native_view = contents->GetNativeView();
  ASSERT_TRUE(native_view);
  auto* root = native_view->GetRootWindow();
  ASSERT_TRUE(root);
  base::WeakPtr<views::Widget> surface;
  for (const auto& widget : views::Widget::GetAllChildWidgets(root)) {
    if (widget->GetName() == "VelmrenAgentSurface") {
      ASSERT_FALSE(surface);
      surface = widget->GetWeakPtr();
    }
  }
  ASSERT_TRUE(surface);

  // Match shutdown ordering: the platform window is gone, but its
  // client-owned Widget and the hidden target have not been released yet.
  surface->CloseNow();
  ASSERT_TRUE(surface);
  ASSERT_FALSE(surface->GetNativeWindow());
  ASSERT_TRUE(contents_weak);
  ASSERT_TRUE(SendCommandSync("Target.closeTarget",
                              base::DictValue().Set("targetId", id)));
  ASSERT_TRUE(base::test::RunUntil([&]() { return !contents_weak; }));
  EXPECT_FALSE(surface);
}
#endif  // defined(USE_AURA)

IN_PROC_BROWSER_TEST_F(VelmrenAgentTargetBrowserTest,
                       RequiresAgentModeAndTrustedBrowserSession) {
  const std::string id = CreateHiddenTarget();
  ASSERT_TRUE(ContentsFor(id));
  {
    base::test::ScopedCommandLine command_line;
    command_line.GetProcessCommandLine()->RemoveSwitch("velmren-agent-mode");
    EXPECT_FALSE(SetVisibility(id, true));
    ASSERT_TRUE(error());
    EXPECT_EQ(-32000, error()->FindInt("code"));
  }
  SetIsTrusted(false);
  EXPECT_FALSE(SetVisibility(id, true));
  ASSERT_TRUE(error());
  EXPECT_EQ(-32000, error()->FindInt("code"));
  SetIsTrusted(true);
  content::TestDevToolsProtocolClient page_session;
  page_session.AttachToWebContents(ContentsFor(id));
  EXPECT_FALSE(page_session.SendCommandSync(
      "Target.setTargetVisibility",
      base::DictValue().Set("targetId", id).Set("visible", true)));
  page_session.DetachProtocolClient();
  ASSERT_TRUE(SetVisibility(id, true));
}
