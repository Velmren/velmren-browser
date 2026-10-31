/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include <string>

#include "base/command_line.h"
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
#include "content/public/test/browser_test.h"
#include "content/public/test/browser_test_utils.h"
#include "content/public/test/test_devtools_protocol_client.h"
#include "net/test/embedded_test_server/embedded_test_server.h"
#include "ui/base/base_window.h"

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
  std::string CreateHiddenTarget() {
    const auto* response = SendCommandSync(
        "Target.createTarget",
        base::DictValue()
            .Set("url", embedded_test_server()->GetURL("/empty.html").spec())
            .Set("hidden", true)
            .Set("forTab", false)
            .Set("newWindow", false)
            .Set("background", true));
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
  )", content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
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
            )", content::EXECUTE_SCRIPT_DEFAULT_OPTIONS,
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
  auto* ordinary_contents = browser()->tab_strip_model()->GetActiveWebContents();
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
  handoff->GetTabStripModel()->CloseWebContents(
      contents, TabCloseTypes::CLOSE_NONE);
  ASSERT_TRUE(base::test::RunUntil([&]() { return !weak_contents; }));
  EXPECT_FALSE(SetVisibility(id, false));
  ASSERT_TRUE(error());
  EXPECT_EQ(-32602, error()->FindInt("code"));
}

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
