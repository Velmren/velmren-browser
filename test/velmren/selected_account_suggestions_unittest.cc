/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include <algorithm>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/callback.h"
#include "base/i18n/rtl.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/test/gmock_callback_support.h"
#include "base/test/scoped_feature_list.h"
#include "base/test/task_environment.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "components/autofill/core/browser/filling/filling_product.h"
#include "components/autofill/core/browser/foundations/autofill_driver.h"
#include "components/autofill/core/browser/foundations/autofill_driver_test_api.h"
#include "components/autofill/core/browser/foundations/test_autofill_client.h"
#include "components/autofill/core/browser/foundations/test_autofill_driver.h"
#include "components/autofill/core/browser/integrators/password_manager/password_manager_delegate.h"
#include "components/autofill/core/browser/suggestions/suggestion.h"
#include "components/autofill/core/browser/suggestions/suggestion_type.h"
#include "components/autofill/core/browser/ui/autofill_suggestion_delegate.h"
#include "components/autofill/core/common/aliases.h"
#include "components/autofill/core/common/autofill_test_util.h"
#include "components/autofill/core/common/form_data.h"
#include "components/autofill/core/common/form_field_data.h"
#include "components/autofill/core/common/mojom/autofill_types.mojom.h"
#include "components/autofill/core/common/password_form_fill_data.h"
#include "components/autofill/core/common/unique_ids.h"
#include "components/password_manager/core/browser/mock_webauthn_credentials_delegate.h"
#include "components/password_manager/core/browser/passkey_credential.h"
#include "components/password_manager/core/browser/password_autofill_manager.h"
#include "components/password_manager/core/browser/password_manager.h"
#include "components/password_manager/core/browser/stub_password_manager_client.h"
#include "components/password_manager/core/browser/stub_password_manager_driver.h"
#include "components/password_manager/core/browser/undo_password_change_controller.h"
#include "components/password_manager/core/common/password_manager_features.h"
#include "components/signin/public/identity_manager/identity_test_environment.h"
#include "mojo/public/cpp/test_support/test_utils.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/rect_f.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace password_manager {
namespace {

using autofill::Suggestion;
using autofill::SuggestionType;
using testing::_;
using testing::ElementsAre;
using testing::Return;

constexpr char kAccountUrl[] = "https://accounts.google.com/signin/password";
constexpr char16_t kSelectedUsername[] = u"zulu@example.com";

class SelectedAccountDriver : public StubPasswordManagerDriver {
 public:
  SelectedAccountDriver(autofill::AutofillDriver* autofill_driver,
                        PasswordManagerInterface* password_manager)
      : autofill_driver_(autofill_driver),
        password_manager_(password_manager) {}

  autofill::AutofillDriver* GetAutofillDriver() const override {
    return autofill_driver_;
  }
  const GURL& GetLastCommittedURL() const override { return url_; }
  const url::Origin& GetLastCommittedOrigin() const override { return origin_; }
  DriverId GetId() const override { return id_; }
  bool IsInPrimaryMainFrame() const override { return main_frame_; }
  PasswordManagerInterface* GetPasswordManager() override {
    return password_manager_;
  }
  void SetId(DriverId id) { id_ = id; }
  void SetMainFrame(bool main_frame) { main_frame_ = main_frame; }
  void SetUrl(const GURL& url) {
    url_ = url;
    origin_ = url::Origin::Create(url_);
  }
  MOCK_METHOD(void,
              FillSuggestion,
              (const std::u16string&,
               const std::u16string&,
               base::OnceCallback<void(bool)>),
              (override));

 private:
  raw_ptr<autofill::AutofillDriver> autofill_driver_;
  raw_ptr<PasswordManagerInterface> password_manager_;
  DriverId id_{1};
  bool main_frame_ = true;
  GURL url_{kAccountUrl};
  url::Origin origin_ = url::Origin::Create(url_);
};

class SelectedAccountPasswordClient : public StubPasswordManagerClient {
 public:
  const GURL& GetLastCommittedURL() const override { return url_; }
  signin::IdentityManager* GetIdentityManager() override {
    return identity_environment_.identity_manager();
  }
  const signin::IdentityManager* GetIdentityManager() const override {
    return identity_environment_.identity_manager();
  }
  WebAuthnCredentialsDelegate* GetWebAuthnCredentialsDelegateForDriver(
      PasswordManagerDriver*) override {
    return &webauthn_delegate;
  }

  testing::NiceMock<MockWebAuthnCredentialsDelegate> webauthn_delegate;

 private:
  const GURL url_{kAccountUrl};
  signin::IdentityTestEnvironment identity_environment_;
};

class SelectedAccountAutofillClient : public autofill::TestAutofillClient {
 public:
  SuggestionUiSessionId ShowAutofillSuggestions(
      const PopupOpenArgs& args,
      base::WeakPtr<autofill::AutofillSuggestionDelegate> delegate) override {
    ++show_count;
    popup_delegate = delegate;
    SetAutofillSuggestions(args.suggestions);
    return TestAutofillClient::ShowAutofillSuggestions(args, delegate);
  }
  void UpdateAutofillSuggestions(
      const std::vector<Suggestion>& suggestions,
      autofill::FillingProduct,
      autofill::AutofillSuggestionTriggerSource,
      autofill::AutofillSuggestionsIgnoreFocusLoss) override {
    SetAutofillSuggestions(suggestions);
  }

  size_t show_count = 0;
  base::WeakPtr<autofill::AutofillSuggestionDelegate> popup_delegate;
};

class VelmrenSelectedAccountSuggestionsTest : public testing::Test {
 protected:
  void SetUp() override {
    autofill_driver_.SetLocalFrameToken(autofill::test::MakeLocalFrameToken());
    fill_data_.url = GURL(kAccountUrl);
    fill_data_.form_renderer_id = autofill::FormRendererId(1);
    fill_data_.password_element_renderer_id = autofill::FieldRendererId(2);
    fill_data_.username_element_renderer_id = autofill::FieldRendererId(3);
    fill_data_.wait_for_username = true;
    fill_data_.preferred_login = Credential(u"charlie@example.com", u"charlie");
    fill_data_.additional_logins = {
        Credential(u"alpha@example.com", u"alpha"),
        Credential(kSelectedUsername, u"selected password")};
    EXPECT_CALL(password_driver_, FillSuggestion).Times(0);
    manager_.OnAddPasswordFillData(fill_data_);
  }

  void TearDown() override {
    autofill::test_api(autofill_driver_)
        .SetLifecycleState(
            autofill::AutofillDriver::LifecycleState::kPendingDeletion);
  }

  autofill::PasswordAndMetadata Credential(std::u16string username,
                                           std::u16string password) {
    autofill::PasswordAndMetadata credential;
    credential.username_value = std::move(username);
    credential.password_value = std::move(password);
    credential.realm = "https://google.com/";
    return credential;
  }

  autofill::PasswordSuggestionRequest Request(
      std::u16string username = kSelectedUsername) {
    autofill::FormData form;
    form.set_url(GURL(kAccountUrl));
    form.set_host_frame(autofill_driver_.GetFrameToken());
    form.set_renderer_id(fill_data_.form_renderer_id);
    autofill::FormFieldData username_field;
    username_field.set_host_frame(form.host_frame());
    username_field.set_host_form_id(form.renderer_id());
    username_field.set_origin(url::Origin::Create(form.url()));
    username_field.set_renderer_id(autofill::FieldRendererId(3));
    username_field.set_name(u"identifier");
    username_field.set_form_control_type(
        autofill::FormControlType::kInputEmail);
    username_field.set_autocomplete_attribute("username");
    username_field.set_value(std::move(username));
    autofill::FormFieldData password_field = username_field;
    password_field.set_renderer_id(fill_data_.password_element_renderer_id);
    password_field.set_name(u"password");
    password_field.set_form_control_type(
        autofill::FormControlType::kInputPassword);
    password_field.set_autocomplete_attribute("current-password");
    password_field.set_value(u"");
    form.set_fields({username_field, password_field});
    return {autofill::TriggeringField(
                password_field.global_id(),
                autofill::AutofillSuggestionTriggerSource::
                    kFormControlElementClicked,
                base::i18n::LEFT_TO_RIGHT, u"",
                /*show_webauthn_credentials=*/false,
                /*show_identity_credentials=*/false, gfx::RectF(0, 0, 200, 20)),
            form, username_field.global_id(), password_field.global_id()};
  }

  void Show(const autofill::PasswordSuggestionRequest& request) {
    // Exercise the same virtual delegate entry point as BrowserAutofillManager.
    autofill::PasswordManagerDelegate& delegate = manager_;
    delegate.ShowSuggestionsWithFormData(request);
  }

  autofill::PasswordSuggestionRequest PasswordOnlyRequest() {
    auto request = Request();
    auto fields = request.form_data.ExtractFields();
    fields.erase(fields.begin());
    request.form_data.set_fields(std::move(fields));
    request.username_field_id = {};
    return request;
  }

  void TypeFirstStepUsername(std::u16string username = kSelectedUsername,
                             bool explicit_username = true,
                             bool is_otp = false,
                             int field_id = 40) {
    tab_password_manager_.OnUserModifiedNonPasswordField(
        &password_driver_, autofill::FieldRendererId(field_id), username,
        explicit_username, is_otp);
  }

  bool ShowLegacyPopup(const autofill::TriggeringField& field,
                       bool offers_generation) {
    return offers_generation
               ? manager_.MaybeShowPasswordSuggestionsWithGeneration(
                     field.element_id, field.bounds, field.text_direction,
                     /*show_password_suggestions=*/true)
               : manager_.MaybeShowPasswordSuggestions(
                     field.element_id, field.bounds, field.text_direction);
  }

  std::vector<Suggestion> Suggestions() {
    auto suggestions = autofill_client_.GetAutofillSuggestions();
    return {suggestions.begin(), suggestions.end()};
  }

  std::vector<std::u16string> PasswordUsernames() {
    std::vector<std::u16string> usernames;
    for (const auto& suggestion : Suggestions()) {
      if (suggestion.type == SuggestionType::kPasswordEntry ||
          suggestion.type == SuggestionType::kAccountStoragePasswordEntry) {
        usernames.push_back(suggestion.main_text.value);
      }
    }
    return usernames;
  }

  void ExpectOrdinaryOrder() {
    EXPECT_THAT(PasswordUsernames(),
                ElementsAre(u"charlie@example.com", u"alpha@example.com",
                            kSelectedUsername));
  }

  void ExpectSelectedOrder() {
    EXPECT_THAT(PasswordUsernames(),
                ElementsAre(kSelectedUsername, u"charlie@example.com",
                            u"alpha@example.com"));
  }

  base::test::SingleThreadTaskEnvironment task_environment_{
      base::test::TaskEnvironment::TimeSource::MOCK_TIME};
  autofill::test::AutofillUnitTestEnvironment autofill_environment_;
  SelectedAccountPasswordClient password_client_;
  PasswordManager tab_password_manager_{&password_client_};
  SelectedAccountAutofillClient autofill_client_;
  autofill::TestAutofillDriver autofill_driver_{&autofill_client_};
  testing::StrictMock<SelectedAccountDriver> password_driver_{
      &autofill_driver_, &tab_password_manager_};
  PasswordAutofillManager manager_{&password_driver_, &autofill_client_,
                                   &password_client_};
  autofill::PasswordFormFillData fill_data_;
};

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       SelectedAccountFirstRetainsOthersAndFillsOnlyAfterAcceptance) {
  const auto request = Request();
  Show(request);
  ExpectSelectedOrder();
  const auto suggestions = Suggestions();
  ASSERT_EQ(suggestions.size(), 5u);
  EXPECT_EQ(suggestions.front().type, SuggestionType::kPasswordEntry);
  EXPECT_EQ(suggestions[3].type, SuggestionType::kSeparator);
  EXPECT_EQ(suggestions[4].type, SuggestionType::kAllSavedPasswordsEntry);
  ASSERT_TRUE(autofill_client_.popup_delegate);
  ASSERT_TRUE(testing::Mock::VerifyAndClearExpectations(&password_driver_));
  EXPECT_CALL(password_driver_,
              FillSuggestion(std::u16string(kSelectedUsername),
                             std::u16string(u"selected password"), _))
      .WillOnce(base::test::RunOnceCallback<2>(true));
  autofill_client_.popup_delegate->DidAcceptSuggestion(
      suggestions.front(), {.multi_index = {0}}, request.form_data.global_id(),
      request.password_field_id);
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       CurrentIdentityRoundTripsAcrossRendererBrowserMojoBoundary) {
  for (const auto& username :
       {std::optional<std::u16string>(), std::optional<std::u16string>(u""),
        std::optional<std::u16string>(kSelectedUsername)}) {
    auto original = PasswordOnlyRequest();
    original.selected_username = username;
    autofill::PasswordSuggestionRequest copy;
    ASSERT_TRUE(mojo::test::SerializeAndDeserialize<
                autofill::mojom::PasswordSuggestionRequest>(original, copy));
    EXPECT_EQ(copy.selected_username, username);
  }
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       StructuredCurrentIdentityRanksPasswordOnlyRequestsAndRefreshes) {
  auto request = PasswordOnlyRequest();
  request.selected_username = kSelectedUsername;
  Show(request);
  ExpectSelectedOrder();
  manager_.OnAddPasswordFillData(fill_data_);
  ExpectSelectedOrder();
  request.selected_username = u"alpha@example.com";
  Show(request);
  EXPECT_THAT(PasswordUsernames(),
              ElementsAre(u"alpha@example.com", u"charlie@example.com",
                          kSelectedUsername));
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       SubmittedUsernameFirstSurvivesPasswordOnlyNavigation) {
  TypeFirstStepUsername();
  tab_password_manager_.DidNavigateMainFrame(/*form_may_be_submitted=*/true);
  manager_.DidNavigateFrame();
  manager_.OnAddPasswordFillData(fill_data_);
  Show(PasswordOnlyRequest());
  ExpectSelectedOrder();
  tab_password_manager_.DidNavigateMainFrame(/*form_may_be_submitted=*/false);
  manager_.DidNavigateFrame();
  manager_.OnAddPasswordFillData(fill_data_);
  Show(PasswordOnlyRequest());
  ExpectOrdinaryOrder();
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       UsernameFirstSubmissionCanReplaceMainFrameDriverButCannotBridgeFrames) {
  TypeFirstStepUsername();
  tab_password_manager_.DidNavigateMainFrame(/*form_may_be_submitted=*/true);
  password_driver_.SetId(DriverId(2));
  autofill_driver_.SetLocalFrameToken(autofill::test::MakeLocalFrameToken());
  manager_.DidNavigateFrame();
  manager_.OnAddPasswordFillData(fill_data_);
  Show(PasswordOnlyRequest());
  ExpectSelectedOrder();
  password_driver_.SetMainFrame(false);
  Show(PasswordOnlyRequest());
  ExpectOrdinaryOrder();

  tab_password_manager_.DidNavigateMainFrame(/*form_may_be_submitted=*/false);
  TypeFirstStepUsername();
  tab_password_manager_.DidNavigateMainFrame(/*form_may_be_submitted=*/true);
  password_driver_.SetMainFrame(true);
  password_driver_.SetId(DriverId(3));
  Show(PasswordOnlyRequest());
  ExpectOrdinaryOrder();
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       ReplacedDriverMayReuseThePreviousUsernameRendererIdForItsPassword) {
  TypeFirstStepUsername(kSelectedUsername, true, false, 40);
  tab_password_manager_.DidNavigateMainFrame(/*form_may_be_submitted=*/true);
  password_driver_.SetId(DriverId(2));
  autofill_driver_.SetLocalFrameToken(autofill::test::MakeLocalFrameToken());
  fill_data_.password_element_renderer_id = autofill::FieldRendererId(40);
  manager_.DidNavigateFrame();
  manager_.OnAddPasswordFillData(fill_data_);
  Show(PasswordOnlyRequest());
  ExpectSelectedOrder();
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       ChangingAutocompleteRoleCannotKeepAnEarlierExplicitUsername) {
  TypeFirstStepUsername();
  Show(PasswordOnlyRequest());
  ExpectSelectedOrder();
  TypeFirstStepUsername(kSelectedUsername, /*explicit_username=*/false);
  Show(PasswordOnlyRequest());
  ExpectOrdinaryOrder();
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       UsernameFirstRequiresFreshExplicitSameFrameSameOriginNonOtpCandidate) {
  for (int variant = 0; variant != 6; ++variant) {
    SCOPED_TRACE(variant);
    tab_password_manager_.DidNavigateMainFrame(/*form_may_be_submitted=*/false);
    if (variant == 2) {
      password_driver_.SetUrl(GURL("https://unrelated.test/signin"));
    }
    TypeFirstStepUsername(kSelectedUsername, /*explicit_username=*/variant != 0,
                          /*is_otp=*/variant == 1,
                          /*field_id=*/variant == 4 ? 2 : 40);
    password_driver_.SetUrl(GURL(kAccountUrl));
    if (variant == 3) {
      password_driver_.SetId(DriverId(9));
    } else if (variant == 5) {
      task_environment_.FastForwardBy(base::Minutes(6));
    }
    Show(PasswordOnlyRequest());
    ExpectOrdinaryOrder();
    password_driver_.SetId(DriverId(1));
  }
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       CurrentEmptyConflictingUnknownOrChangedIdentityOverridesPreviousStep) {
  TypeFirstStepUsername();
  for (const auto* username :
       {u"", u"unknown@example.com", u"Zulu@example.com"}) {
    auto request = PasswordOnlyRequest();
    request.selected_username = username;
    Show(request);
    ExpectOrdinaryOrder();
    Show(Request(username));
    ExpectOrdinaryOrder();
  }
  auto conflicting = Request();
  conflicting.selected_username = u"alpha@example.com";
  Show(conflicting);
  ExpectOrdinaryOrder();
  auto changed = PasswordOnlyRequest();
  changed.selected_username = u"alpha@example.com";
  Show(changed);
  EXPECT_THAT(PasswordUsernames(),
              ElementsAre(u"alpha@example.com", u"charlie@example.com",
                          kSelectedUsername));
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       LatestUsernameFirstEditWinsAndEmptyEditCannotReviveAnOlderAccount) {
  TypeFirstStepUsername();
  task_environment_.FastForwardBy(base::Milliseconds(1));
  TypeFirstStepUsername(u"alpha@example.com", true, false, 41);
  Show(PasswordOnlyRequest());
  EXPECT_THAT(PasswordUsernames(),
              ElementsAre(u"alpha@example.com", u"charlie@example.com",
                          kSelectedUsername));
  TypeFirstStepUsername(u"", true, false, 41);
  Show(PasswordOnlyRequest());
  ExpectOrdinaryOrder();
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       CurrentMetadataCannotBypassForeignOriginFrameOrPasswordIdentity) {
  for (int variant = 0; variant != 3; ++variant) {
    SCOPED_TRACE(variant);
    auto request = PasswordOnlyRequest();
    request.selected_username = kSelectedUsername;
    if (variant == 0) {
      request.form_data.set_url(GURL("https://unrelated.test/signin"));
    } else if (variant == 1) {
      request.form_data.set_host_frame(autofill::test::MakeLocalFrameToken());
    } else {
      request.password_field_id.renderer_id = autofill::FieldRendererId(9);
    }
    Show(request);
    ExpectOrdinaryOrder();
  }
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       CssHiddenExplicitUsernameWorksWithoutRendererUsernameAssociation) {
  for (bool readonly : {false, true}) {
    auto request = Request();
    request.username_field_id = {};
    auto fields = request.form_data.ExtractFields();
    fields.front().set_name(u"hiddenEmail");
    fields.front().set_is_focusable(false);
    fields.front().set_is_readonly(readonly);
    fields.front().set_autocomplete_attribute("section-signin username");
    request.form_data.set_fields(std::move(fields));
    Show(request);
    ExpectSelectedOrder();
  }
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       MissingOrAmbiguousUsernameDoesNotUseOtherFormText) {
  for (int variant = 0; variant != 4; ++variant) {
    SCOPED_TRACE(variant);
    Show(Request());
    auto request = Request();
    request.username_field_id = {};
    auto fields = request.form_data.ExtractFields();
    switch (variant) {
      case 0:
        fields.erase(fields.begin());
        fields.front().set_label(kSelectedUsername);
        break;
      case 1:
        fields.front().set_autocomplete_attribute("");
        break;
      case 2: {
        auto second_username = fields.front();
        second_username.set_renderer_id(autofill::FieldRendererId(4));
        fields.push_back(second_username);
        break;
      }
      case 3:
        fields.front().set_form_control_type(
            autofill::FormControlType::kTextArea);
        break;
    }
    request.form_data.set_fields(std::move(fields));
    Show(request);
    ExpectOrdinaryOrder();
  }
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       EmptyPartialUnknownAndCaseDifferentUsernamesKeepOrdinaryOrder) {
  for (const auto* username : {u"", u"zulu", u"unknown@example.com",
                               u"Zulu@example.com", u" zulu@example.com "}) {
    SCOPED_TRACE(testing::PrintToString(std::u16string(username)));
    Show(Request());
    Show(Request(username));
    ExpectOrdinaryOrder();
  }
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       ChangedSelectedAccountUsesTheNewRequest) {
  Show(Request());
  ExpectSelectedOrder();
  Show(Request(u"alpha@example.com"));
  EXPECT_THAT(PasswordUsernames(),
              ElementsAre(u"alpha@example.com", u"charlie@example.com",
                          kSelectedUsername));
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       EmptyUsernameDisplayLabelDoesNotCountAsASelectedAccount) {
  fill_data_.additional_logins.push_back(Credential(u"", u"empty username"));
  manager_.OnAddPasswordFillData(fill_data_);
  manager_.ShowSuggestions(Request().field);
  const auto ordinary = Suggestions();
  const auto empty_credential =
      std::ranges::find_if(ordinary, [](const auto& suggestion) {
        return suggestion.type == SuggestionType::kPasswordEntry &&
               !suggestion.main_text.is_primary;
      });
  ASSERT_NE(empty_credential, ordinary.end());
  // Use the generated localized IDS_PASSWORD_MANAGER_EMPTY_LOGIN replacement.
  Show(Request(empty_credential->main_text.value));
  EXPECT_EQ(Suggestions(), ordinary);
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       RealUsernameMatchingEmptyLabelDoesNotPromoteTheEmptyCredential) {
  fill_data_.additional_logins.push_back(Credential(u"", u"empty username"));
  manager_.OnAddPasswordFillData(fill_data_);
  manager_.ShowSuggestions(Request().field);
  const auto initial = Suggestions();
  const auto empty_credential =
      std::ranges::find_if(initial, [](const auto& suggestion) {
        return suggestion.type == SuggestionType::kPasswordEntry &&
               !suggestion.main_text.is_primary;
      });
  ASSERT_NE(empty_credential, initial.end());
  const auto empty_label = empty_credential->main_text.value;
  fill_data_.additional_logins.push_back(
      Credential(empty_label, u"real username"));
  manager_.OnAddPasswordFillData(fill_data_);
  const auto request = Request(empty_label);
  manager_.ShowSuggestions(request.field);
  const auto ordinary = Suggestions();
  Show(request);
  const auto ranked = Suggestions();
  ASSERT_GE(ranked.size(), 2u);
  EXPECT_EQ(ranked.front().main_text.value, empty_label);
  EXPECT_TRUE(ranked.front().main_text.is_primary.value());
  EXPECT_EQ(ranked[1].main_text.value, u"charlie@example.com");
  EXPECT_THAT(ranked, testing::UnorderedElementsAreArray(ordinary));
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       DirectFieldRequestAndFocusChangeClearSelection) {
  const auto request = Request();
  Show(request);
  manager_.ShowSuggestions(request.field);
  ExpectOrdinaryOrder();
  Show(request);
  manager_.FocusedInputChanged();
  manager_.OnAddPasswordFillData(fill_data_);
  ExpectOrdinaryOrder();
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       BothLegacyPopupEntryPointsClearSelectionBeforeFillDataRefresh) {
  const auto request = Request();
  for (bool offers_generation : {false, true}) {
    SCOPED_TRACE(offers_generation);
    Show(request);
    ExpectSelectedOrder();
    ASSERT_TRUE(ShowLegacyPopup(request.field, offers_generation));
    ExpectOrdinaryOrder();
    manager_.OnAddPasswordFillData(fill_data_);
    ExpectOrdinaryOrder();
  }
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       CurrentPopupRefreshRetainsSelectionButFormChangeClearsIt) {
  Show(Request());
  manager_.OnAddPasswordFillData(fill_data_);
  ExpectSelectedOrder();
  auto different_form = fill_data_;
  different_form.form_renderer_id = autofill::FormRendererId(9);
  manager_.OnAddPasswordFillData(different_form);
  ExpectOrdinaryOrder();
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       SameFieldIdsWithDifferentOriginOrFrameClearSelectionOnRefresh) {
  Show(Request());
  auto other_origin = fill_data_;
  other_origin.url = GURL("https://unrelated.test/signin");
  manager_.OnAddPasswordFillData(other_origin);
  ExpectOrdinaryOrder();
  manager_.OnAddPasswordFillData(fill_data_);
  Show(Request());
  autofill_driver_.SetLocalFrameToken(autofill::test::MakeLocalFrameToken());
  manager_.OnAddPasswordFillData(fill_data_);
  ExpectOrdinaryOrder();
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       CredentialsArrivingAfterTheRequestUseItsValidatedUsername) {
  const auto request = Request();
  manager_.DeleteFillData();
  std::vector<PasskeyCredential> passkeys;
  passkeys.emplace_back(PasskeyCredential::Source::kWindowsHello,
                        PasskeyCredential::RpId("accounts.google.com"),
                        PasskeyCredential::CredentialId({1, 2}),
                        PasskeyCredential::UserId({3, 4}),
                        PasskeyCredential::Username("passkey@example.com"));
  ON_CALL(password_client_.webauthn_delegate, GetPasskeys)
      .WillByDefault(Return(base::ok(&passkeys)));
  auto waiting_request = request;
  waiting_request.field.show_webauthn_credentials = true;
  Show(waiting_request);
  EXPECT_THAT(PasswordUsernames(), testing::IsEmpty());
  ASSERT_TRUE(autofill_client_.IsShowingAutofillPopup());
  manager_.OnAddPasswordFillData(fill_data_);
  ExpectSelectedOrder();
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       ForeignFrameFormOriginOrPasswordFieldCannotRankThePopup) {
  for (int variant = 0; variant != 8; ++variant) {
    SCOPED_TRACE(variant);
    auto request = Request();
    auto fields = request.form_data.ExtractFields();
    switch (variant) {
      case 0:
        fields.front().set_host_frame(autofill::test::MakeLocalFrameToken());
        request.username_field_id = fields.front().global_id();
        break;
      case 1:
        fields.front().set_host_form_id(autofill::FormRendererId(9));
        break;
      case 2:
        request.form_data.set_host_frame(autofill::test::MakeLocalFrameToken());
        for (auto& field : fields) {
          field.set_host_frame(request.form_data.host_frame());
        }
        request.field.element_id = fields.back().global_id();
        request.password_field_id = fields.back().global_id();
        request.username_field_id = fields.front().global_id();
        break;
      case 3:
        request.form_data.set_renderer_id(autofill::FormRendererId(9));
        for (auto& field : fields) {
          field.set_host_form_id(request.form_data.renderer_id());
        }
        break;
      case 4:
        request.password_field_id.renderer_id = autofill::FieldRendererId(9);
        break;
      case 5:
        request.form_data.set_url(GURL("https://unrelated.test/signin"));
        break;
      case 6:
        request.username_field_id.renderer_id = autofill::FieldRendererId(9);
        break;
      case 7:
        fields.front().set_origin(
            url::Origin::Create(GURL("https://unrelated.test/")));
        break;
    }
    request.form_data.set_fields(std::move(fields));
    Show(Request());
    Show(request);
    ExpectOrdinaryOrder();
  }
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       DuplicateStoresRecoveryAndPasskeyRowsKeepTheirPayloadsAndSections) {
  auto& selected = fill_data_.additional_logins.back();
  selected.backup_password_value = u"selected backup";
  auto account_copy = Credential(kSelectedUsername, u"account password");
  account_copy.uses_account_store = true;
  fill_data_.additional_logins.push_back(account_copy);
  manager_.OnAddPasswordFillData(fill_data_);
  const auto& profile_selected = fill_data_.additional_logins[1];
  auto* undo = password_client_.GetUndoPasswordChangeController();
  undo->OnSuggestionSelected(profile_selected);
  undo->OnTroubleSigningInClicked(Suggestion::PasswordSuggestionDetails(
      profile_selected.username_value, profile_selected.password_value,
      *profile_selected.backup_password_value, profile_selected.realm, false));

  std::vector<PasskeyCredential> passkeys;
  passkeys.emplace_back(PasskeyCredential::Source::kWindowsHello,
                        PasskeyCredential::RpId("accounts.google.com"),
                        PasskeyCredential::CredentialId({1, 2}),
                        PasskeyCredential::UserId({3, 4}),
                        PasskeyCredential::Username("passkey@example.com"));
  ON_CALL(password_client_.webauthn_delegate, GetPasskeys)
      .WillByDefault(Return(base::ok(&passkeys)));
  auto request = Request();
  request.field.show_webauthn_credentials = true;
  manager_.ShowSuggestions(request.field);
  const auto ordinary = Suggestions();
  Show(request);
  const auto ranked = Suggestions();
  ASSERT_EQ(ranked.size(), ordinary.size());
  ASSERT_EQ(ranked.front().type, SuggestionType::kWebauthnCredential);
  EXPECT_EQ(ranked.front(), ordinary.front());
  EXPECT_EQ(ranked[ranked.size() - 2], ordinary[ordinary.size() - 2]);
  EXPECT_EQ(ranked.back(), ordinary.back());
  EXPECT_THAT(ranked, testing::UnorderedElementsAreArray(ordinary));
  ASSERT_GE(ranked.size(), 6u);
  for (size_t i = 1; i != 4; ++i) {
    EXPECT_EQ(ranked[i].main_text.value, kSelectedUsername);
  }
  EXPECT_THAT(PasswordUsernames(),
              ElementsAre(kSelectedUsername, kSelectedUsername,
                          u"charlie@example.com", u"alpha@example.com"));

  auto account = std::ranges::find(
      ranked, SuggestionType::kAccountStoragePasswordEntry, &Suggestion::type);
  ASSERT_NE(account, ranked.end());
  ASSERT_TRUE(testing::Mock::VerifyAndClearExpectations(&password_driver_));
  EXPECT_CALL(password_driver_,
              FillSuggestion(std::u16string(kSelectedUsername),
                             std::u16string(u"account password"), _))
      .WillOnce(base::test::RunOnceCallback<2>(true));
  ASSERT_TRUE(autofill_client_.popup_delegate);
  autofill_client_.popup_delegate->DidAcceptSuggestion(
      *account, {.multi_index = {1}}, request.form_data.global_id(),
      request.password_field_id);
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       OlderPasskeyCallbackCannotConsumeTheNewSelectedAccount) {
  base::test::ScopedFeatureList feature(
      features::kDelaySuggestionsOnAutofocusWaitingForPasskeys);
  std::vector<base::OnceClosure> callbacks;
  ON_CALL(password_client_.webauthn_delegate, GetPasskeys)
      .WillByDefault(Return(
          base::unexpected(WebAuthnCredentialsDelegate::
                               PasskeysUnavailableReason::kNotReceived)));
  EXPECT_CALL(password_client_.webauthn_delegate,
              RequestNotificationWhenPasskeysReady)
      .Times(2)
      .WillRepeatedly([&](base::OnceClosure callback) {
        callbacks.push_back(std::move(callback));
      });
  auto request = Request();
  request.field.show_webauthn_credentials = true;
  request.field.trigger_source = autofill::AutofillSuggestionTriggerSource::
      kPasswordManagerProcessedFocusedField;
  Show(request);
  auto newer = Request(u"alpha@example.com");
  newer.field = request.field;
  Show(newer);
  ASSERT_EQ(callbacks.size(), 2u);
  EXPECT_EQ(autofill_client_.show_count, 0u);
  const std::vector<PasskeyCredential> passkeys;
  ON_CALL(password_client_.webauthn_delegate, GetPasskeys)
      .WillByDefault(Return(base::ok(&passkeys)));
  std::move(callbacks[0]).Run();
  EXPECT_EQ(autofill_client_.show_count, 0u);
  std::move(callbacks[1]).Run();
  EXPECT_EQ(autofill_client_.show_count, 1u);
  EXPECT_THAT(PasswordUsernames(),
              ElementsAre(u"alpha@example.com", u"charlie@example.com",
                          kSelectedUsername));
  task_environment_.FastForwardBy(base::Seconds(1));
  EXPECT_EQ(autofill_client_.show_count, 1u);
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       PendingStructuredIdentityCannotOutliveAccountChangeOrNavigation) {
  base::test::ScopedFeatureList feature(
      features::kDelaySuggestionsOnAutofocusWaitingForPasskeys);
  std::vector<base::OnceClosure> callbacks;
  ON_CALL(password_client_.webauthn_delegate, GetPasskeys)
      .WillByDefault(Return(
          base::unexpected(WebAuthnCredentialsDelegate::
                               PasskeysUnavailableReason::kNotReceived)));
  EXPECT_CALL(password_client_.webauthn_delegate,
              RequestNotificationWhenPasskeysReady)
      .Times(3)
      .WillRepeatedly([&](base::OnceClosure callback) {
        callbacks.push_back(std::move(callback));
      });
  auto request = PasswordOnlyRequest();
  request.selected_username = kSelectedUsername;
  request.field.show_webauthn_credentials = true;
  request.field.trigger_source = autofill::AutofillSuggestionTriggerSource::
      kPasswordManagerProcessedFocusedField;
  Show(request);
  request.selected_username = u"alpha@example.com";
  Show(request);
  ASSERT_EQ(callbacks.size(), 2u);
  const std::vector<PasskeyCredential> passkeys;
  ON_CALL(password_client_.webauthn_delegate, GetPasskeys)
      .WillByDefault(Return(base::ok(&passkeys)));
  std::move(callbacks[0]).Run();
  EXPECT_EQ(autofill_client_.show_count, 0u);
  std::move(callbacks[1]).Run();
  EXPECT_EQ(autofill_client_.show_count, 1u);
  EXPECT_THAT(PasswordUsernames(),
              ElementsAre(u"alpha@example.com", u"charlie@example.com",
                          kSelectedUsername));

  ON_CALL(password_client_.webauthn_delegate, GetPasskeys)
      .WillByDefault(Return(
          base::unexpected(WebAuthnCredentialsDelegate::
                               PasskeysUnavailableReason::kNotReceived)));
  Show(request);
  ASSERT_EQ(callbacks.size(), 3u);
  manager_.DidNavigateFrame();
  const size_t shows_before_navigation = autofill_client_.show_count;
  std::move(callbacks[2]).Run();
  task_environment_.FastForwardBy(base::Seconds(1));
  EXPECT_EQ(autofill_client_.show_count, shows_before_navigation);
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       BothLegacyPopupEntryPointsCancelPendingPasskeyCallbacks) {
  base::test::ScopedFeatureList feature(
      features::kDelaySuggestionsOnAutofocusWaitingForPasskeys);
  ON_CALL(password_client_.webauthn_delegate, GetPasskeys)
      .WillByDefault(Return(
          base::unexpected(WebAuthnCredentialsDelegate::
                               PasskeysUnavailableReason::kNotReceived)));
  for (bool offers_generation : {false, true}) {
    SCOPED_TRACE(offers_generation);
    base::OnceClosure callback;
    EXPECT_CALL(password_client_.webauthn_delegate,
                RequestNotificationWhenPasskeysReady)
        .WillOnce(
            [&](base::OnceClosure ready) { callback = std::move(ready); });
    auto request = Request();
    request.field.show_webauthn_credentials = true;
    request.field.trigger_source = autofill::AutofillSuggestionTriggerSource::
        kPasswordManagerProcessedFocusedField;
    Show(request);
    ASSERT_TRUE(callback);
    ASSERT_TRUE(ShowLegacyPopup(request.field, offers_generation));
    ExpectOrdinaryOrder();
    const size_t show_count = autofill_client_.show_count;
    std::move(callback).Run();
    task_environment_.FastForwardBy(base::Seconds(1));
    EXPECT_EQ(autofill_client_.show_count, show_count);
    manager_.OnAddPasswordFillData(fill_data_);
    ExpectOrdinaryOrder();
  }
}

TEST_F(VelmrenSelectedAccountSuggestionsTest,
       FocusNavigationDeletionFormChangeAndDirectRequestCancelPendingRanking) {
  base::test::ScopedFeatureList feature(
      features::kDelaySuggestionsOnAutofocusWaitingForPasskeys);
  ON_CALL(password_client_.webauthn_delegate, GetPasskeys)
      .WillByDefault(Return(
          base::unexpected(WebAuthnCredentialsDelegate::
                               PasskeysUnavailableReason::kNotReceived)));
  for (int boundary = 0; boundary != 5; ++boundary) {
    SCOPED_TRACE(boundary);
    manager_.OnAddPasswordFillData(fill_data_);
    base::OnceClosure callback;
    EXPECT_CALL(password_client_.webauthn_delegate,
                RequestNotificationWhenPasskeysReady)
        .WillOnce(
            [&](base::OnceClosure ready) { callback = std::move(ready); });
    auto request = Request();
    request.field.show_webauthn_credentials = true;
    request.field.trigger_source = autofill::AutofillSuggestionTriggerSource::
        kPasswordManagerProcessedFocusedField;
    Show(request);
    ASSERT_TRUE(callback);
    switch (boundary) {
      case 0:
        manager_.FocusedInputChanged();
        break;
      case 1:
        manager_.DidNavigateFrame();
        break;
      case 2:
        manager_.DeleteFillData();
        break;
      case 3: {
        auto other_form = fill_data_;
        other_form.form_renderer_id = autofill::FormRendererId(9);
        manager_.OnAddPasswordFillData(other_form);
        break;
      }
      case 4:
        manager_.ShowSuggestions(Request().field);
        break;
    }
    const size_t show_count = autofill_client_.show_count;
    std::move(callback).Run();
    task_environment_.FastForwardBy(base::Seconds(1));
    EXPECT_EQ(autofill_client_.show_count, show_count);
    manager_.OnAddPasswordFillData(fill_data_);
    manager_.ShowSuggestions(Request().field);
    ExpectOrdinaryOrder();
  }
}

}  // namespace
}  // namespace password_manager
