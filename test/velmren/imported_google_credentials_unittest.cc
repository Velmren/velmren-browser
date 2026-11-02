/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/functional/callback.h"
#include "base/i18n/rtl.h"
#include "base/memory/weak_ptr.h"
#include "base/test/gmock_callback_support.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "base/types/expected.h"
#include "components/affiliations/core/browser/affiliation_utils.h"
#include "components/affiliations/core/browser/match_type.h"
#include "components/affiliations/core/browser/mock_affiliation_service.h"
#include "components/autofill/core/browser/filling/filling_product.h"
#include "components/autofill/core/browser/foundations/autofill_client.h"
#include "components/autofill/core/browser/foundations/test_autofill_client.h"
#include "components/autofill/core/browser/suggestions/suggestion.h"
#include "components/autofill/core/browser/suggestions/suggestion_hiding_reason.h"
#include "components/autofill/core/browser/suggestions/suggestion_type.h"
#include "components/autofill/core/browser/ui/autofill_suggestion_delegate.h"
#include "components/autofill/core/common/aliases.h"
#include "components/autofill/core/common/autofill_test_util.h"
#include "components/autofill/core/common/form_field_data.h"
#include "components/autofill/core/common/password_form_fill_data.h"
#include "components/autofill/core/common/unique_ids.h"
#include "components/password_manager/core/browser/affiliation/affiliated_match_helper.h"
#include "components/password_manager/core/browser/fake_form_fetcher.h"
#include "components/password_manager/core/browser/mock_webauthn_credentials_delegate.h"
#include "components/password_manager/core/browser/password_autofill_manager.h"
#include "components/password_manager/core/browser/password_form.h"
#include "components/password_manager/core/browser/password_form_digest.h"
#include "components/password_manager/core/browser/password_form_filling.h"
#include "components/password_manager/core/browser/password_save_manager_impl.h"
#include "components/password_manager/core/browser/password_store/fake_password_store_backend.h"
#include "components/password_manager/core/browser/password_store/get_logins_with_affiliations_request_handler.h"
#include "components/password_manager/core/browser/password_store/mock_password_store_backend.h"
#include "components/password_manager/core/browser/password_store/password_form_converters.h"
#include "components/password_manager/core/browser/password_store/password_store_backend_error.h"
#include "components/password_manager/core/browser/password_store/password_store_change.h"
#include "components/password_manager/core/browser/password_store/psl_matching_helper.h"
#include "components/password_manager/core/browser/password_store/stored_credential.h"
#include "components/password_manager/core/browser/password_string.h"
#include "components/password_manager/core/browser/stub_form_saver.h"
#include "components/password_manager/core/browser/stub_password_manager_client.h"
#include "components/password_manager/core/browser/stub_password_manager_driver.h"
#include "components/signin/public/identity_manager/identity_test_environment.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/rect_f.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "url/scheme_host_port.h"

namespace password_manager {
namespace {

using testing::_;
using testing::ElementsAre;
using testing::IsEmpty;
using testing::StrictMock;

constexpr char kGoogleRealm[] = "https://google.com/";
constexpr char kAccountsRealm[] = "https://accounts.google.com/";
constexpr char kMyAccountRealm[] = "https://myaccount.google.com/";

using LoginsResult =
    base::expected<std::vector<StoredCredential>, PasswordStoreBackendError>;

PasswordFormDigest Digest(const std::string& realm) {
  return {PasswordForm::Scheme::kHtml, realm, GURL(realm)};
}

StoredCredential ImportedCredential(
    const std::string& realm = kGoogleRealm,
    std::u16string_view username = u"imported") {
  StoredCredential credential;
  credential.signon_realm = realm;
  credential.url = GURL(realm);
  credential.username_value = username;
  credential.password_value = PasswordString(u"test password");
  credential.type = PasswordForm::Type::kImported;
  credential.in_store = PasswordForm::Store::kProfileStore;
  return credential;
}

std::vector<StoredCredential> OneCredential(StoredCredential credential) {
  std::vector<StoredCredential> result;
  result.push_back(std::move(credential));
  return result;
}

// Keep Chromium's real fake-store filtering, while recording the requests sent
// by the public handler. This catches accidentally enabling Google root PSL.
class RecordingPasswordStoreBackend : public FakePasswordStoreBackend {
 public:
  struct Query {
    bool include_psl;
    std::vector<PasswordFormDigest> digests;
  };

  void FillMatchingLoginsAsync(
      BackendLoginsOrErrorReply callback,
      bool include_psl,
      const std::vector<PasswordFormDigest>& digests) override {
    queries.push_back({include_psl, digests});
    FakePasswordStoreBackend::FillMatchingLoginsAsync(std::move(callback),
                                                      include_psl, digests);
  }

  std::vector<Query> queries;
};

class MockImportedCredentialDriver : public StubPasswordManagerDriver {
 public:
  MOCK_METHOD(void,
              FillSuggestion,
              (const std::u16string&,
               const std::u16string&,
               base::OnceCallback<void(bool)>),
              (override));
};

class ImportedCredentialPasswordManagerClient
    : public StubPasswordManagerClient {
 public:
  explicit ImportedCredentialPasswordManagerClient(const GURL& url)
      : url_(url) {}

  const GURL& GetLastCommittedURL() const override { return url_; }

  signin::IdentityManager* GetIdentityManager() override {
    return identity_test_environment_.identity_manager();
  }

  const signin::IdentityManager* GetIdentityManager() const override {
    return identity_test_environment_.identity_manager();
  }

  WebAuthnCredentialsDelegate* GetWebAuthnCredentialsDelegateForDriver(
      PasswordManagerDriver*) override {
    return &webauthn_delegate_;
  }

 private:
  const GURL url_;
  signin::IdentityTestEnvironment identity_test_environment_;
  testing::NiceMock<MockWebAuthnCredentialsDelegate> webauthn_delegate_;
};

class MockImportedCredentialAutofillClient
    : public autofill::TestAutofillClient {
 public:
  MOCK_METHOD(autofill::AutofillClient::SuggestionUiSessionId,
              ShowAutofillSuggestions,
              (const autofill::AutofillClient::PopupOpenArgs&,
               base::WeakPtr<autofill::AutofillSuggestionDelegate>),
              (override));
  MOCK_METHOD(void,
              HideSuggestions,
              (autofill::SuggestionHidingReason,
               std::optional<autofill::FillingProduct>),
              (override));
};

class VelmrenImportedGoogleCredentialsTest : public testing::Test {
 protected:
  void Add(StoredCredential credential) {
    base::test::TestFuture<base::expected<
        std::optional<PasswordStoreChangeList>, PasswordStoreBackendError>>
        added;
    backend_.AddLoginAsync(std::move(credential), added.GetCallback());
    ASSERT_TRUE(added.Get().has_value());
  }

  LoginsResult Lookup(const PasswordFormDigest& digest,
                      AffiliatedMatchHelper* helper = nullptr) {
    base::test::TestFuture<LoginsResult> completed;
    GetLoginsWithAffiliationsRequestHandler(digest, &backend_, helper,
                                            completed.GetCallback());
    return completed.Take();
  }

  LoginsResult LookupWithAliasReply(
      std::vector<StoredCredential> imported_credentials,
      std::vector<StoredCredential> ordinary_credentials = {}) {
    StrictMock<MockPasswordStoreBackend> backend;
    testing::InSequence sequence;
    EXPECT_CALL(backend, FillMatchingLoginsAsync(
                             _, true, ElementsAre(Digest(kAccountsRealm))))
        .WillOnce([&ordinary_credentials](BackendLoginsOrErrorReply callback,
                                          bool, const auto&) {
          std::move(callback).Run(std::move(ordinary_credentials));
        });
    EXPECT_CALL(backend, FillMatchingLoginsAsync(
                             _, false, ElementsAre(Digest(kGoogleRealm))))
        .WillOnce([&imported_credentials](BackendLoginsOrErrorReply callback,
                                          bool, const auto&) {
          std::move(callback).Run(std::move(imported_credentials));
        });
    base::test::TestFuture<LoginsResult> completed;
    GetLoginsWithAffiliationsRequestHandler(Digest(kAccountsRealm), &backend,
                                            nullptr, completed.GetCallback());
    return completed.Take();
  }

  base::test::SingleThreadTaskEnvironment task_environment_;
  RecordingPasswordStoreBackend backend_;
};

TEST_F(VelmrenImportedGoogleCredentialsTest,
       ExistingImportMatchesBothAccountOriginsWithoutChangingStoredIdentity) {
  auto imported = ImportedCredential();
  imported.primary_key = FormPrimaryKey(47);
  imported.url = GURL("https://google.com/legacy/signin?source=csv");
  auto expected = CloneStoredCredential(imported);
  Add(std::move(imported));

  for (const auto* realm : {kAccountsRealm, kMyAccountRealm}) {
    SCOPED_TRACE(realm);
    backend_.queries.clear();
    auto observed = Digest(realm);
    observed.url = GURL(std::string(realm) + "signin/v2/identifier");
    auto result = Lookup(observed);
    ASSERT_TRUE(result.has_value());
    ASSERT_EQ(result->size(), 1u);
    EXPECT_TRUE(AreStoredCredentialUniqueKeysEqual(result->front(), expected));
    EXPECT_EQ(result->front().primary_key, expected.primary_key);
    EXPECT_EQ(result->front().password_value, expected.password_value);
    EXPECT_EQ(result->front().match_type, affiliations::MatchType::kAffiliated);
    ASSERT_EQ(backend_.queries.size(), 2u);
    EXPECT_TRUE(backend_.queries[0].include_psl);
    EXPECT_THAT(backend_.queries[0].digests, ElementsAre(observed));
    EXPECT_FALSE(backend_.queries[1].include_psl);
    EXPECT_THAT(backend_.queries[1].digests, ElementsAre(Digest(kGoogleRealm)));
  }

  base::test::TestFuture<LoginsResult> stored;
  backend_.GetAllLoginsAsync(stored.GetCallback());
  ASSERT_TRUE(stored.Get().has_value());
  ASSERT_EQ(stored.Get()->size(), 1u);
  EXPECT_EQ(ToPasswordForm(stored.Get()->front()), ToPasswordForm(expected));
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       GeneratedSuggestionAcceptsImportedCredentialOnBothSignInSteps) {
  Add(ImportedCredential());
  autofill::test::AutofillUnitTestEnvironment autofill_environment;

  for (const auto* realm : {kAccountsRealm, kMyAccountRealm}) {
    SCOPED_TRACE(realm);
    auto result = Lookup(Digest(realm));
    ASSERT_TRUE(result.has_value());
    ASSERT_EQ(result->size(), 1u);
    ASSERT_EQ(result->front().match_type, affiliations::MatchType::kAffiliated);

    for (const bool username_first : {true, false}) {
      SCOPED_TRACE(username_first ? "username first" : "password step");
      PasswordForm observed;
      observed.url = GURL(std::string(realm) + "signin");
      observed.signon_realm = realm;
      observed.form_data.set_url(observed.url);
      observed.form_data.set_renderer_id(autofill::FormRendererId(1));

      autofill::FormFieldData field;
      field.set_renderer_id(autofill::FieldRendererId(2));
      field.set_name(username_first ? u"identifier" : u"password");
      field.set_form_control_type(
          username_first ? autofill::FormControlType::kInputEmail
                         : autofill::FormControlType::kInputPassword);
      observed.form_data.set_fields({field});
      if (username_first) {
        observed.username_element_renderer_id = field.renderer_id();
      } else {
        observed.password_element_renderer_id = field.renderer_id();
      }

      const autofill::PasswordFormFillData fill_data =
          CreatePasswordFormFillData(observed, *result, &result->front(),
                                     url::Origin::Create(observed.url),
                                     /*wait_for_username=*/true,
                                     /*suggestion_banned_fields=*/{});
      EXPECT_TRUE(fill_data.wait_for_username);
      EXPECT_EQ(fill_data.username_element_renderer_id,
                observed.username_element_renderer_id);
      EXPECT_EQ(fill_data.password_element_renderer_id,
                observed.password_element_renderer_id);
      EXPECT_EQ(fill_data.preferred_login.realm, kGoogleRealm);

      ImportedCredentialPasswordManagerClient client(observed.url);
      StrictMock<MockImportedCredentialDriver> driver;
      StrictMock<MockImportedCredentialAutofillClient> autofill_client;
      PasswordAutofillManager manager(&driver, &autofill_client, &client);
      EXPECT_CALL(driver, FillSuggestion).Times(0);
      manager.OnAddPasswordFillData(fill_data);

      // Capture the popup boundary used by
      // password_autofill_manager_unittest.cc and accept its generated entry
      // through the actual suggestion delegate.
      autofill::AutofillClient::PopupOpenArgs open_args;
      base::WeakPtr<autofill::AutofillSuggestionDelegate> popup_delegate;
      EXPECT_CALL(autofill_client, ShowAutofillSuggestions)
          .WillOnce([&](const autofill::AutofillClient::PopupOpenArgs& args,
                        base::WeakPtr<autofill::AutofillSuggestionDelegate>
                            delegate) {
            open_args = args;
            popup_delegate = delegate;
            return autofill_client.TestAutofillClient::ShowAutofillSuggestions(
                args, delegate);
          });
      const autofill::TriggeringField triggering_field(
          field.global_id(),
          autofill::AutofillSuggestionTriggerSource::kFormControlElementClicked,
          base::i18n::LEFT_TO_RIGHT, username_first ? u"imp" : u"",
          /*show_webauthn_credentials=*/false,
          /*show_identity_credentials=*/false, gfx::RectF(0, 0, 200, 20));
      manager.ShowSuggestions(triggering_field);

      ASSERT_TRUE(popup_delegate);
      EXPECT_EQ(popup_delegate.get(), &manager);
      EXPECT_EQ(manager.GetQueriedFieldId(), field.global_id());
      ASSERT_FALSE(open_args.suggestions.empty());
      const autofill::Suggestion suggestion = open_args.suggestions.front();
      ASSERT_EQ(suggestion.type, autofill::SuggestionType::kPasswordEntry);
      EXPECT_EQ(suggestion.main_text.value, u"imported");
      ASSERT_TRUE(testing::Mock::VerifyAndClearExpectations(&driver));

      EXPECT_CALL(driver, FillSuggestion(std::u16string(u"imported"),
                                         std::u16string(u"test password"), _))
          .WillOnce(base::test::RunOnceCallback<2>(true));
      EXPECT_CALL(
          autofill_client,
          HideSuggestions(autofill::SuggestionHidingReason::kAcceptSuggestion,
                          std::optional(autofill::FillingProduct::kPassword)));
      popup_delegate->DidAcceptSuggestion(suggestion, {.multi_index = {0}},
                                          observed.form_data.global_id(),
                                          field.global_id());
    }
  }
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       RootRemainsExcludedFromOrdinaryPublicSuffixMatching) {
  Add(ImportedCredential());
  EXPECT_FALSE(IsPublicSuffixDomainMatch(kGoogleRealm, kAccountsRealm));
  EXPECT_FALSE(IsPublicSuffixDomainMatch(kAccountsRealm, kGoogleRealm));
  base::test::TestFuture<LoginsResult> ordinary;
  backend_.FillMatchingLoginsAsync(ordinary.GetCallback(), true,
                                   {Digest(kAccountsRealm)});
  ASSERT_TRUE(ordinary.Get().has_value());
  EXPECT_THAT(*ordinary.Get(), IsEmpty());

  auto result = Lookup(Digest(kAccountsRealm));
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 1u);
  EXPECT_EQ(result->front().match_type, affiliations::MatchType::kAffiliated);
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       CanonicalDefaultPortAndSourcePathAreAccepted) {
  auto imported = ImportedCredential();
  imported.url = GURL("https://google.com:443/path?query#fragment");
  Add(std::move(imported));
  auto target = Digest(kAccountsRealm);
  target.url = GURL("https://accounts.google.com:443/signin?query#fragment");
  auto result = Lookup(target);
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 1u);
  EXPECT_EQ(result->front().url,
            GURL("https://google.com/path?query#fragment"));
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       AliasResultsRequireImportedUsableHtmlPassword) {
  std::vector<StoredCredential> candidates;
  for (const auto type :
       {PasswordForm::Type::kFormSubmission, PasswordForm::Type::kGenerated,
        PasswordForm::Type::kApi, PasswordForm::Type::kManuallyAdded,
        PasswordForm::Type::kReceivedViaSharing,
        PasswordForm::Type::kImportedViaCredentialExchange,
        PasswordForm::Type::kChangeSubmission}) {
    auto credential = ImportedCredential();
    credential.type = type;
    candidates.push_back(std::move(credential));
  }
  for (const auto scheme :
       {PasswordForm::Scheme::kBasic, PasswordForm::Scheme::kDigest,
        PasswordForm::Scheme::kOther, PasswordForm::Scheme::kUsernameOnly}) {
    auto credential = ImportedCredential();
    credential.scheme = scheme;
    candidates.push_back(std::move(credential));
  }
  auto blocked = ImportedCredential();
  blocked.blocked_by_user = true;
  candidates.push_back(std::move(blocked));
  auto federated = ImportedCredential();
  federated.federation_origin = url::SchemeHostPort(GURL("https://idp.test/"));
  candidates.push_back(std::move(federated));
  auto empty = ImportedCredential();
  empty.password_value.clear();
  candidates.push_back(std::move(empty));

  auto result = LookupWithAliasReply(std::move(candidates));
  ASSERT_TRUE(result.has_value());
  EXPECT_THAT(*result, IsEmpty());
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       AliasResultsRequireCanonicalGoogleRootRealmAndOrigin) {
  std::vector<StoredCredential> candidates;
  for (const auto* realm :
       {"http://google.com/", "https://www.google.com/",
        "https://google.co.uk/", "https://accounts.google.com/",
        "https://myaccount.google.com/", "https://google.com.evil.test/",
        "https://google.com:444/", "https://google.com:443/",
        "https://google.com./", "https://GOOGLE.com/", "https://google.com",
        "https://google.com/path", "federation://google.com/idp.test",
        "not a URL"}) {
    auto credential = ImportedCredential();
    credential.signon_realm = realm;
    candidates.push_back(std::move(credential));
  }
  for (const auto* url :
       {"http://google.com/", "https://www.google.com/",
        "https://google.co.uk/", "https://accounts.google.com/",
        "https://myaccount.google.com/", "https://google.com.evil.test/",
        "https://google.com:444/", "https://google.com./",
        "https://user:secret@google.com/", "https://user@google.com/",
        "https://google.com@evil.test/", "not a URL"}) {
    auto credential = ImportedCredential();
    credential.url = GURL(url);
    candidates.push_back(std::move(credential));
  }
  auto result = LookupWithAliasReply(std::move(candidates));
  ASSERT_TRUE(result.has_value());
  EXPECT_THAT(*result, IsEmpty());
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       IneligibleTargetsPerformOnlyTheUnchangedOrdinaryLookup) {
  std::vector<PasswordFormDigest> targets;
  for (const auto* realm :
       {"http://accounts.google.com/", "https://accounts.google.com:444/",
        "https://google.com/", "https://www.google.com/",
        "https://mail.google.com/", "https://m.accounts.google.com/",
        "https://accounts.google.co.uk/", "https://accounts.google.com./",
        "https://accounts.google.com.evil.test/",
        "https://evilaccounts.google.com/",
        "https://myaccount.google.com.evil/",
        "https://accounts.google.com:443/", "https://ACCOUNTS.google.com/",
        "https://accounts.google.com/path", "not a URL"}) {
    targets.push_back(Digest(realm));
  }
  for (const auto* url :
       {"http://accounts.google.com/", "https://accounts.google.com:444/",
        "https://myaccount.google.com/", "https://accounts.google.com./",
        "https://accounts.google.com.evil.test/",
        "https://user:secret@accounts.google.com/",
        "https://user@accounts.google.com/", "not a URL"}) {
    auto target = Digest(kAccountsRealm);
    target.url = GURL(url);
    targets.push_back(std::move(target));
  }
  for (const auto scheme :
       {PasswordForm::Scheme::kBasic, PasswordForm::Scheme::kDigest,
        PasswordForm::Scheme::kOther, PasswordForm::Scheme::kUsernameOnly}) {
    auto target = Digest(kAccountsRealm);
    target.scheme = scheme;
    targets.push_back(std::move(target));
  }
  for (const auto& target : targets) {
    SCOPED_TRACE(target.signon_realm);
    SCOPED_TRACE(target.url);
    StrictMock<MockPasswordStoreBackend> backend;
    EXPECT_CALL(backend, FillMatchingLoginsAsync(_, _, ElementsAre(target)))
        .WillOnce([](BackendLoginsOrErrorReply callback, bool, const auto&) {
          std::move(callback).Run(std::vector<StoredCredential>());
        });
    base::test::TestFuture<LoginsResult> completed;
    GetLoginsWithAffiliationsRequestHandler(target, &backend, nullptr,
                                            completed.GetCallback());
    ASSERT_TRUE(completed.Get().has_value());
    EXPECT_THAT(*completed.Get(), IsEmpty());
  }
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       ExactAccountCredentialWinsForSameUsernameEvenWithDifferentPassword) {
  auto exact = ImportedCredential(kAccountsRealm);
  exact.type = PasswordForm::Type::kFormSubmission;
  exact.password_value = PasswordString(u"newer password");
  Add(CloneStoredCredential(exact));
  Add(ImportedCredential());
  Add(ImportedCredential(kGoogleRealm, u"another account"));

  auto result = Lookup(Digest(kAccountsRealm));
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 2u);
  EXPECT_EQ(result->at(0).match_type, affiliations::MatchType::kExact);
  EXPECT_EQ(result->at(0).password_value, exact.password_value);
  EXPECT_EQ(result->at(1).username_value, u"another account");
  EXPECT_EQ(result->at(1).match_type, affiliations::MatchType::kAffiliated);
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       ExactFederatedCredentialDoesNotSuppressImportedPassword) {
  auto federated = ImportedCredential(kAccountsRealm);
  federated.signon_realm = "federation://accounts.google.com/idp.test";
  federated.federation_origin = url::SchemeHostPort(GURL("https://idp.test/"));
  Add(std::move(federated));
  Add(ImportedCredential());

  auto result = Lookup(Digest(kAccountsRealm));
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 2u);
  EXPECT_EQ(result->at(0).match_type, affiliations::MatchType::kExact);
  EXPECT_TRUE(result->at(0).federation_origin.IsValid());
  EXPECT_EQ(result->at(1).signon_realm, kGoogleRealm);
  EXPECT_EQ(result->at(1).match_type, affiliations::MatchType::kAffiliated);
  EXPECT_EQ(result->at(1).username_value, result->at(0).username_value);
  EXPECT_FALSE(result->at(1).password_value.empty());
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       ExactBlockedCredentialDoesNotSuppressImportedPassword) {
  auto blocked = ImportedCredential(kAccountsRealm);
  blocked.blocked_by_user = true;
  Add(std::move(blocked));
  Add(ImportedCredential());

  auto result = Lookup(Digest(kAccountsRealm));
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 2u);
  EXPECT_EQ(result->at(0).match_type, affiliations::MatchType::kExact);
  EXPECT_TRUE(result->at(0).blocked_by_user);
  EXPECT_EQ(result->at(1).signon_realm, kGoogleRealm);
  EXPECT_EQ(result->at(1).match_type, affiliations::MatchType::kAffiliated);
  EXPECT_EQ(result->at(1).username_value, result->at(0).username_value);
  EXPECT_FALSE(result->at(1).blocked_by_user);
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       ExactEmptyPasswordDoesNotSuppressImportedPassword) {
  auto empty = ImportedCredential(kAccountsRealm);
  empty.password_value.clear();
  Add(std::move(empty));
  Add(ImportedCredential());

  auto result = Lookup(Digest(kAccountsRealm));
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 2u);
  EXPECT_EQ(result->at(0).match_type, affiliations::MatchType::kExact);
  EXPECT_TRUE(result->at(0).password_value.empty());
  EXPECT_EQ(result->at(1).signon_realm, kGoogleRealm);
  EXPECT_EQ(result->at(1).match_type, affiliations::MatchType::kAffiliated);
  EXPECT_EQ(result->at(1).username_value, result->at(0).username_value);
  EXPECT_FALSE(result->at(1).password_value.empty());
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       DuplicateImportedKeysAreSuppressed) {
  auto imported = ImportedCredential();
  imported.primary_key = FormPrimaryKey(47);
  std::vector<StoredCredential> candidates;
  candidates.push_back(CloneStoredCredential(imported));
  imported.password_value = PasswordString(u"different password same key");
  candidates.push_back(std::move(imported));
  auto result = LookupWithAliasReply(std::move(candidates));
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 1u);
  EXPECT_EQ(result->front().primary_key, FormPrimaryKey(47));
  EXPECT_EQ(result->front().password_value, u"test password");
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       ExistingAffiliationMatchIsNotAddedAgain) {
  Add(ImportedCredential());
  StrictMock<affiliations::MockAffiliationService> service;
  AffiliatedMatchHelper helper(&service);
  EXPECT_CALL(service, GetPSLExtensions)
      .WillOnce(base::test::RunOnceCallback<0>(std::vector<std::string>()));
  std::vector<affiliations::Facet> facets;
  facets.emplace_back(
      affiliations::FacetURI::FromPotentiallyInvalidSpec(kGoogleRealm));
  EXPECT_CALL(service, GetAffiliationsAndBranding)
      .WillOnce(base::test::RunOnceCallback<1>(facets, true));
  EXPECT_CALL(service, GetGroupingInfo)
      .WillOnce(base::test::RunOnceCallback<1>(
          std::vector<affiliations::GroupedFacets>(1)));

  auto result = Lookup(Digest(kAccountsRealm), &helper);
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 1u);
  EXPECT_EQ(result->front().match_type, affiliations::MatchType::kAffiliated);
  ASSERT_EQ(backend_.queries.size(), 3u);
  EXPECT_THAT(backend_.queries[1].digests, ElementsAre(Digest(kGoogleRealm)));
  EXPECT_THAT(backend_.queries[2].digests, ElementsAre(Digest(kGoogleRealm)));
  EXPECT_FALSE(backend_.queries[1].include_psl);
  EXPECT_FALSE(backend_.queries[2].include_psl);
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       AccountCredentialsDoNotLeakBackToRootOrOtherOrigins) {
  Add(ImportedCredential(kAccountsRealm));
  Add(ImportedCredential(kMyAccountRealm, u"my account"));
  for (const auto* realm : {kGoogleRealm, "https://google.com.evil.test/",
                            "https://unrelated.test/"}) {
    SCOPED_TRACE(realm);
    auto result = Lookup(Digest(realm));
    ASSERT_TRUE(result.has_value());
    EXPECT_THAT(*result, IsEmpty());
  }
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       OrdinaryExactAndSubdomainMatchesKeepTheirOriginalTypes) {
  Add(ImportedCredential("https://example.com/", u"exact"));
  Add(ImportedCredential("https://m.example.com/", u"subdomain"));
  Add(ImportedCredential());
  auto result = Lookup(Digest("https://example.com/"));
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 2u);
  EXPECT_EQ(result->at(0).username_value, u"exact");
  EXPECT_EQ(result->at(0).match_type, affiliations::MatchType::kExact);
  EXPECT_EQ(result->at(1).username_value, u"subdomain");
  EXPECT_EQ(result->at(1).match_type, affiliations::MatchType::kPSL);
  ASSERT_EQ(backend_.queries.size(), 1u);
  EXPECT_TRUE(backend_.queries[0].include_psl);
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       OrdinaryGoogleSubdomainMatchingStillWorksAlongsideTheImport) {
  Add(ImportedCredential(kAccountsRealm, u"exact"));
  Add(ImportedCredential("https://m.accounts.google.com/", u"subdomain"));
  Add(ImportedCredential());
  auto result = Lookup(Digest(kAccountsRealm));
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 3u);
  EXPECT_EQ(result->at(0).username_value, u"exact");
  EXPECT_EQ(result->at(0).match_type, affiliations::MatchType::kExact);
  EXPECT_EQ(result->at(1).username_value, u"subdomain");
  EXPECT_EQ(result->at(1).match_type, affiliations::MatchType::kPSL);
  EXPECT_EQ(result->at(2).username_value, u"imported");
  EXPECT_EQ(result->at(2).match_type, affiliations::MatchType::kAffiliated);
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       OriginalErrorPropagatesWithoutAnAliasQuery) {
  StrictMock<MockPasswordStoreBackend> backend;
  const PasswordStoreBackendError error(
      PasswordStoreBackendErrorType::kUncategorized);
  EXPECT_CALL(backend, FillMatchingLoginsAsync(
                           _, true, ElementsAre(Digest(kAccountsRealm))))
      .WillOnce(
          [&error](BackendLoginsOrErrorReply callback, bool, const auto&) {
            std::move(callback).Run(base::unexpected(error));
          });
  base::test::TestFuture<LoginsResult> completed;
  GetLoginsWithAffiliationsRequestHandler(Digest(kAccountsRealm), &backend,
                                          nullptr, completed.GetCallback());
  ASSERT_FALSE(completed.Get().has_value());
  EXPECT_EQ(completed.Get().error(), error);
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       AliasErrorPreservesSuccessfulOrdinaryResults) {
  StrictMock<MockPasswordStoreBackend> backend;
  testing::InSequence sequence;
  EXPECT_CALL(backend, FillMatchingLoginsAsync(
                           _, true, ElementsAre(Digest(kAccountsRealm))))
      .WillOnce([](BackendLoginsOrErrorReply callback, bool, const auto&) {
        std::move(callback).Run(
            OneCredential(ImportedCredential(kAccountsRealm)));
      });
  EXPECT_CALL(backend, FillMatchingLoginsAsync(
                           _, false, ElementsAre(Digest(kGoogleRealm))))
      .WillOnce([](BackendLoginsOrErrorReply callback, bool, const auto&) {
        std::move(callback).Run(base::unexpected(PasswordStoreBackendError(
            PasswordStoreBackendErrorType::kUncategorized)));
      });
  base::test::TestFuture<LoginsResult> completed;
  GetLoginsWithAffiliationsRequestHandler(Digest(kAccountsRealm), &backend,
                                          nullptr, completed.GetCallback());
  ASSERT_TRUE(completed.Get().has_value());
  ASSERT_EQ(completed.Get()->size(), 1u);
  EXPECT_EQ(completed.Get()->front().signon_realm, kAccountsRealm);
  EXPECT_EQ(completed.Get()->front().match_type,
            affiliations::MatchType::kExact);
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       BackendDestroyedBeforeOrdinaryReplyCompletesOnceWithoutAliasQuery) {
  auto backend = std::make_unique<StrictMock<MockPasswordStoreBackend>>();
  BackendLoginsOrErrorReply ordinary_reply;
  EXPECT_CALL(*backend, FillMatchingLoginsAsync(
                            _, true, ElementsAre(Digest(kAccountsRealm))))
      .WillOnce([&ordinary_reply](BackendLoginsOrErrorReply callback, bool,
                                  const auto&) {
        ordinary_reply = std::move(callback);
      });
  base::test::TestFuture<LoginsResult> completed;
  GetLoginsWithAffiliationsRequestHandler(Digest(kAccountsRealm), backend.get(),
                                          nullptr, completed.GetCallback());
  EXPECT_FALSE(completed.IsReady());
  backend.reset();
  std::move(ordinary_reply)
      .Run(OneCredential(ImportedCredential(kAccountsRealm)));
  ASSERT_TRUE(completed.Get().has_value());
  ASSERT_EQ(completed.Get()->size(), 1u);
  EXPECT_EQ(completed.Get()->front().match_type,
            affiliations::MatchType::kExact);
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       BackendDestroyedDuringAliasQueryCanCompleteOnce) {
  auto backend = std::make_unique<StrictMock<MockPasswordStoreBackend>>();
  BackendLoginsOrErrorReply alias_reply;
  testing::InSequence sequence;
  EXPECT_CALL(*backend, FillMatchingLoginsAsync(
                            _, true, ElementsAre(Digest(kAccountsRealm))))
      .WillOnce([](BackendLoginsOrErrorReply callback, bool, const auto&) {
        std::move(callback).Run(std::vector<StoredCredential>());
      });
  EXPECT_CALL(*backend, FillMatchingLoginsAsync(
                            _, false, ElementsAre(Digest(kGoogleRealm))))
      .WillOnce(
          [&alias_reply](BackendLoginsOrErrorReply callback, bool,
                         const auto&) { alias_reply = std::move(callback); });
  base::test::TestFuture<LoginsResult> completed;
  GetLoginsWithAffiliationsRequestHandler(Digest(kAccountsRealm), backend.get(),
                                          nullptr, completed.GetCallback());
  EXPECT_FALSE(completed.IsReady());
  backend.reset();
  std::move(alias_reply).Run(OneCredential(ImportedCredential()));
  ASSERT_TRUE(completed.Get().has_value());
  ASSERT_EQ(completed.Get()->size(), 1u);
  EXPECT_EQ(completed.Get()->front().match_type,
            affiliations::MatchType::kAffiliated);
}

TEST_F(VelmrenImportedGoogleCredentialsTest,
       MatchingPasswordRemainsSavedWithoutCreatingAnAccountRealmCopy) {
  auto imported = ImportedCredential();
  imported.primary_key = FormPrimaryKey(47);
  Add(std::move(imported));
  auto result = Lookup(Digest(kAccountsRealm));
  ASSERT_TRUE(result.has_value());
  ASSERT_EQ(result->size(), 1u);

  FakeFormFetcher fetcher;
  fetcher.SetNonFederated({ToPasswordForm(result->front())});
  fetcher.SetBestMatches({ToPasswordForm(result->front())});
  fetcher.NotifyFetchCompleted();
  StubPasswordManagerClient client;
  PasswordSaveManagerImpl save_manager(std::make_unique<StubFormSaver>(),
                                       nullptr);
  save_manager.Init(&client, &fetcher, nullptr, nullptr);
  PasswordForm submitted = ToPasswordForm(result->front());
  submitted.url = GURL("https://accounts.google.com/signin");
  submitted.signon_realm = kAccountsRealm;
  submitted.type = PasswordForm::Type::kFormSubmission;
  submitted.match_type.reset();
  save_manager.CreatePendingCredentials(submitted, nullptr, submitted.form_data,
                                        /*is_http_auth=*/false,
                                        /*is_credential_api_save=*/false);

  EXPECT_TRUE(save_manager.IsEqualToSavedMatch());
  EXPECT_FALSE(save_manager.IsNewLogin());
  EXPECT_FALSE(save_manager.IsPasswordUpdate());
  EXPECT_EQ(save_manager.GetPendingCredentials().signon_realm, kGoogleRealm);
  EXPECT_EQ(save_manager.GetPendingCredentials().url, GURL(kGoogleRealm));
  EXPECT_EQ(save_manager.GetPendingCredentials().primary_key,
            FormPrimaryKey(47));
}

}  // namespace
}  // namespace password_manager
