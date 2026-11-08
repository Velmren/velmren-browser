/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/strings/strcat.h"
#include "base/test/run_until.h"
#include "components/autofill/content/common/mojom/autofill_driver.mojom.h"
#include "components/autofill/content/renderer/autofill_renderer_test.h"
#include "components/autofill/content/renderer/password_autofill_agent.h"
#include "components/autofill/core/common/form_data.h"
#include "components/autofill/core/common/password_form_fill_data.h"
#include "components/autofill/core/common/unique_ids.h"
#include "content/public/renderer/render_frame.h"
#include "mojo/public/cpp/bindings/associated_receiver.h"
#include "mojo/public/cpp/bindings/pending_associated_receiver.h"
#include "mojo/public/cpp/bindings/scoped_interface_endpoint_handle.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/web/web_input_element.h"
#include "url/gurl.h"

namespace autofill {
namespace {

constexpr char kUrl[] = "https://accounts.google.com/signin/password";
constexpr char16_t kUsername[] = u"zulu@example.com";
constexpr char kPasswordForm[] =
    "<form id='password-form'><input id='password' name='Passwd' "
    "type='password' autocomplete='current-password'></form>";

// The actual renderer Mojo channel is observed here. Browser ranking tests
// separately consume the corresponding public PasswordManager input API.
class RecordingPasswordManagerDriver : public mojom::PasswordManagerDriver {
 public:
  struct Edit {
    FieldRendererId field;
    std::u16string value;
    bool username_role;
    bool otp;
  };

  void Bind(mojo::ScopedInterfaceEndpointHandle handle) {
    receiver_.Bind(
        mojo::PendingAssociatedReceiver<mojom::PasswordManagerDriver>(
            std::move(handle)));
  }
  void PasswordFormsParsed(const std::vector<FormData>&) override {}
  void PasswordFormsRendered(const std::vector<FormData>&) override {}
  void PasswordFormSubmitted(const FormData&) override {}
  void InformAboutUserInput(const FormData&) override {}
  void DynamicFormSubmission(mojom::SubmissionIndicatorEvent) override {}
  void PasswordFormCleared(const FormData&) override {}
  void RecordSavePasswordProgress(const std::string&) override {}
  void UserModifiedPasswordField() override {}
  void UserModifiedNonPasswordField(FieldRendererId field,
                                    const std::u16string& value,
                                    bool username_role,
                                    bool otp) override {
    edits.push_back({field, value, username_role, otp});
  }
  void CheckSafeBrowsingReputation(const GURL&, const GURL&) override {}
  void FocusedInputChanged(FieldRendererId, mojom::FocusedFieldType) override {}
  void LogFirstFillingResult(FormRendererId, int32_t) override {}

  std::vector<Edit> edits;

 private:
  mojo::AssociatedReceiver<mojom::PasswordManagerDriver> receiver_{this};
};

class VelmrenSelectedAccountRendererTest : public test::AutofillRendererTest {
 protected:
  void SetUp() override {
    AutofillRendererTest::SetUp();
    GetMainRenderFrame()
        ->GetRemoteAssociatedInterfaces()
        ->OverrideBinderForTesting(
            mojom::PasswordManagerDriver::Name_,
            base::BindRepeating(&RecordingPasswordManagerDriver::Bind,
                                base::Unretained(&password_driver_)));
  }

  void Load(std::string_view html, std::string_view url = kUrl) {
    LoadHTMLWithUrlOverride(html, url);
    ForceLayoutUpdate();
  }

  std::optional<PasswordSuggestionRequest> Request() {
    return password_autofill_agent()->CreateManualFallbackRequest(
        GetInputElementById("password"), /*form_cache=*/{});
  }

  void EditUsername(std::u16string value, std::string_view autocomplete) {
    auto input = GetInputElementById("username");
    ASSERT_TRUE(input);
    input.SetAttribute("autocomplete",
                       blink::WebString::FromUtf8(autocomplete));
    input.SetValue(blink::WebString::FromUtf16(value));
    const size_t expected = password_driver_.edits.size() + 1;
    // This is the public manual-edit path called by AutofillAgent. Its real
    // DOM extraction and rejected-value branch execute before Mojo delivery.
    password_autofill_agent()->UpdatePasswordStateForTextChange(
        input, /*form_cache=*/{});
    ASSERT_TRUE(base::test::RunUntil(
        [&] { return password_driver_.edits.size() == expected; }));
  }

  RecordingPasswordManagerDriver password_driver_;
};

TEST_F(VelmrenSelectedAccountRendererTest,
       ActualEditCaptureValidatesAutocompleteRoleTokensAndCase) {
  Load(
      base::StrCat({"<form id='username-form'><input id='username' "
                    "name='identifier' type='email'></form>",
                    kPasswordForm}));
  for (const auto& [autocomplete, expected] :
       std::vector<std::pair<std::string_view, bool>>{
           {"username", true},
           {"USERNAME", true},
           {"section-login USERNAME WEBAUTHN", true},
           {"notusername", false},
           {"username-extra", false},
           {"garbage username", false},
           {"email", false}}) {
    SCOPED_TRACE(autocomplete);
    EditUsername(kUsername, autocomplete);
    ASSERT_FALSE(password_driver_.edits.empty());
    EXPECT_EQ(password_driver_.edits.back().value, kUsername);
    EXPECT_EQ(password_driver_.edits.back().username_role, expected);
    EXPECT_FALSE(password_driver_.edits.back().otp);
  }
}

TEST_F(VelmrenSelectedAccountRendererTest,
       ClearedShortAndOversizeEditsInvalidateBeforePasswordOnlySameDocument) {
  Load(
      base::StrCat({"<form id='username-form'><input id='username' "
                    "name='identifier' type='email' autocomplete='username'>"
                    "</form>",
                    kPasswordForm}));
  for (const auto& rejected :
       {std::u16string(), std::u16string(u"x"), std::u16string(101, u'x')}) {
    EditUsername(kUsername, "USERNAME");
    const auto field = password_driver_.edits.back().field;
    EditUsername(rejected, "USERNAME");
    EXPECT_EQ(password_driver_.edits.back().field, field);
    EXPECT_TRUE(password_driver_.edits.back().value.empty());
    EXPECT_TRUE(password_driver_.edits.back().username_role);
  }
  ExecuteJavaScriptForTests(
      "document.getElementById('username-form').remove();");
  ForceLayoutUpdate();
  const auto request = Request();
  ASSERT_TRUE(request);
  EXPECT_FALSE(request->selected_username);
  EXPECT_FALSE(request->username_field_id.renderer_id);
  EXPECT_TRUE(password_driver_.edits.back().value.empty());
}

TEST_F(VelmrenSelectedAccountRendererTest,
       HiddenUsernameUsesTheSameExplicitRoleParserAndFormOwnership) {
  for (const auto& [autocomplete, expected] :
       std::vector<std::pair<std::string_view, bool>>{
           {"username", true},
           {"USERNAME", true},
           {"section-login USERNAME WEBAUTHN", true},
           {"notusername", false},
           {"garbage username", false}}) {
    SCOPED_TRACE(autocomplete);
    Load(base::StrCat(
        {"<form><input type='hidden' autocomplete='", autocomplete,
         "' value='zulu@example.com'><input id='password' name='Passwd' "
         "type='password'></form>"}));
    const auto request = Request();
    ASSERT_TRUE(request);
    EXPECT_EQ(
        request->selected_username,
        expected ? std::optional<std::u16string>(kUsername) : std::nullopt);
  }
  Load(
      base::StrCat({"<form><input type='hidden' autocomplete='username' "
                    "value='zulu@example.com'></form>",
                    kPasswordForm}));
  const auto request = Request();
  ASSERT_TRUE(request);
  EXPECT_FALSE(request->selected_username);
}

TEST_F(VelmrenSelectedAccountRendererTest,
       CurrentChipRequiresVisibleMatchingTextAndRejectsConflictingIdentity) {
  for (const auto& [chip, expected] :
       std::vector<std::pair<std::string_view, std::u16string>>{
           {"<div id='selected-account' data-email='zulu@example.com'>"
            "zulu@example.com</div>",
            kUsername},
           {"<div data-selected-account data-identifier='zulu@example.com'>"
            "<span>zulu@example.com</span></div>",
            kUsername},
           {"<div id='selected-account' data-email='zulu@example.com'></div>",
            u""},
           {"<div id='selected-account' data-email='zulu@example.com'>"
            "<span style='display:none'>zulu@example.com</span></div>",
            u""},
           {"<div id='selected-account' data-email='zulu@example.com'>"
            "<span style='visibility:hidden'>zulu@example.com</span></div>",
            u""},
           {"<div id='selected-account' data-email='zulu@example.com'>"
            "alpha@example.com</div>",
            u""}}) {
    SCOPED_TRACE(chip);
    Load(base::StrCat({chip, kPasswordForm}));
    const auto request = Request();
    ASSERT_TRUE(request);
    ASSERT_TRUE(request->selected_username);
    EXPECT_EQ(*request->selected_username, expected);
  }
  Load(
      "<div id='selected-account' data-email='alpha@example.com'>"
      "alpha@example.com</div><form><input type='hidden' "
      "autocomplete='username' value='zulu@example.com'>"
      "<input id='password' name='Passwd' type='password'></form>");
  const auto request = Request();
  ASSERT_TRUE(request);
  ASSERT_TRUE(request->selected_username);
  EXPECT_TRUE(request->selected_username->empty());
}

TEST_F(VelmrenSelectedAccountRendererTest,
       ArbitraryTextHiddenForeignFormFrameAndMultiplePasswordChipsAreIgnored) {
  for (const auto& markup :
       {"<div data-email='zulu@example.com'>zulu@example.com</div>",
        "<div id='selected-account' data-email='zulu@example.com' "
        "style='display:none'>zulu@example.com</div>",
        "<div style='opacity:0'><div id='selected-account' "
        "data-email='zulu@example.com'>zulu@example.com</div></div>",
        "<form><div id='selected-account' data-email='zulu@example.com'>"
        "zulu@example.com</div></form>",
        "<iframe srcdoc=\"<div id='selected-account' "
        "data-email='zulu@example.com'>zulu@example.com</div>\"></iframe>",
        "<div id='selected-account' data-email='zulu@example.com'>"
        "zulu@example.com</div><input type='password' name='otherPassword'>"}) {
    SCOPED_TRACE(markup);
    Load(base::StrCat({markup, kPasswordForm}));
    const auto request = Request();
    ASSERT_TRUE(request);
    EXPECT_FALSE(request->selected_username);
  }
}

TEST_F(VelmrenSelectedAccountRendererTest,
       GoogleProfileIdentifierIsBoundToCanonicalOriginAndCurrentDocument) {
  const auto html = base::StrCat(
      {"<div id='profileIdentifier'>zulu@example.com</div>", kPasswordForm});
  Load(html);
  auto request = Request();
  ASSERT_TRUE(request);
  EXPECT_EQ(request->selected_username,
            std::optional<std::u16string>(kUsername));
  Load(html, "https://unrelated.test/signin");
  request = Request();
  ASSERT_TRUE(request);
  EXPECT_FALSE(request->selected_username);
  Load(kPasswordForm);
  request = Request();
  ASSERT_TRUE(request);
  EXPECT_FALSE(request->selected_username);
}

}  // namespace
}  // namespace autofill
