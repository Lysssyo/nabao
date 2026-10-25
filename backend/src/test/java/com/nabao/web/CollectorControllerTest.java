package com.nabao.web;

import com.nabao.application.CollectorService;
import com.nabao.application.ApplicationFailure;
import com.nabao.application.port.CollectorGateway;
import com.nabao.domain.CollectorModels;
import com.nabao.domain.CollectorModels.Action;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.MediaType;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import java.util.List;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class CollectorControllerTest {
    CollectorGateway gateway;
    MockMvc http;
    CollectorModels.Status current;
    @BeforeEach void setup() {
        gateway = mock(CollectorGateway.class);
        current = new CollectorModels.Status(true, false,
                new CollectorModels.Session("unchecked", null, "unchecked"), null,
                new CollectorModels.Schedule(true, 360, null),
                new CollectorModels.Login("idle", null, null, null, "login", false), List.of());
        when(gateway.execute(any())).thenReturn(current);
        when(gateway.addAuthor(any())).thenReturn(current);
        when(gateway.deleteAuthor(any())).thenReturn(current);
        http = MockMvcBuilders.standaloneSetup(new CollectorController(new CollectorService(gateway), new InternalKeyAuthorization("test-key"), new ObjectMapper())).build();
    }
    @Test void readsAuthenticatedStatusWithoutCaching() throws Exception {
        http.perform(get("/internal/v1/collector").header("X-Internal-Key", "test-key"))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.session.status").value("unchecked"));
        verify(gateway).execute(Action.STATUS);
    }
    @Test void deniesAllAnonymousActionsIncludingPng() throws Exception {
        for (String path : List.of("/internal/v1/collector", "/internal/v1/collector/login/preview"))
            http.perform(get(path)).andExpect(status().isUnauthorized()).andExpect(header().string("Cache-Control", "no-store"));
        for (String path : List.of("runs", "login", "login/complete", "session/check"))
            http.perform(post("/internal/v1/collector/" + path)).andExpect(status().isUnauthorized());
        http.perform(delete("/internal/v1/collector/login")).andExpect(status().isUnauthorized());
        verifyNoInteractions(gateway);
    }
    @Test void authorMutationsRequireAuthenticationBeforeReadingOrForwardingInput() throws Exception {
        for (String key : List.of("", "wrong-key")) {
            http.perform(post("/internal/v1/collector/authors").header("X-Internal-Key", key)
                    .contentType(MediaType.APPLICATION_JSON).content("SECRET malformed input"))
                    .andExpect(status().isUnauthorized()).andExpect(header().string("Cache-Control", "no-store"));
            http.perform(delete("/internal/v1/collector/authors/123456789012345678901234").header("X-Internal-Key", key))
                    .andExpect(status().isUnauthorized());
        }
        verifyNoInteractions(gateway);
    }

    @Test void addsTrimmedAuthorsAndDeletesOnlyExactIds() throws Exception {
        String id = "123456789012345678901234";
        String profile = "https://www.xiaohongshu.com/user/profile/" + id + "?xsec_token=test";
        http.perform(post("/internal/v1/collector/authors").header("X-Internal-Key", "test-key")
                .contentType(MediaType.APPLICATION_JSON).content(new ObjectMapper().writeValueAsString(
                        new CollectorModels.AuthorInput("  新作者  ", " " + profile + " "))))
                .andExpect(status().isCreated()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.available").value(true));
        verify(gateway).addAuthor(new CollectorModels.AuthorInput("新作者", profile));
        http.perform(delete("/internal/v1/collector/authors/" + id).header("X-Internal-Key", "test-key"))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"));
        verify(gateway).deleteAuthor(id);
    }

    @Test void rejectsMalformedPrivateOversizedAndOffSiteAuthorRequests() throws Exception {
        String profile = "https://www.xiaohongshu.com/user/profile/123456789012345678901234";
        for (String bad : List.of("{}", "{broken", "null", "{} {}",
                "{\"name\":\"作者\",\"name\":\"重复\",\"profileUrl\":\"" + profile + "\"}",
                "{\"name\":\"作者\",\"profileUrl\":\"" + profile + "\",\"private\":\"SECRET\"}")) {
            http.perform(post("/internal/v1/collector/authors").header("X-Internal-Key", "test-key")
                    .contentType(MediaType.APPLICATION_JSON).content(bad))
                    .andExpect(status().isBadRequest()).andExpect(header().string("Cache-Control", "no-store"));
        }
        for (String badProfile : List.of("http://www.xiaohongshu.com/user/profile/123456789012345678901234",
                "https://evil.test/user/profile/123456789012345678901234",
                "https://www.xiaohongshu.com:443/user/profile/123456789012345678901234",
                "https://user:SECRET@www.xiaohongshu.com/user/profile/123456789012345678901234",
                profile + "#fragment", profile + "/../other")) {
            http.perform(post("/internal/v1/collector/authors").header("X-Internal-Key", "test-key")
                    .contentType(MediaType.APPLICATION_JSON).content(new ObjectMapper().writeValueAsString(
                            new CollectorModels.AuthorInput("作者", badProfile))))
                    .andExpect(status().isBadRequest());
        }
        for (String name : List.of(" ", "x".repeat(81))) {
            http.perform(post("/internal/v1/collector/authors").header("X-Internal-Key", "test-key")
                    .contentType(MediaType.APPLICATION_JSON).content(new ObjectMapper().writeValueAsString(
                            new CollectorModels.AuthorInput(name, profile))))
                    .andExpect(status().isBadRequest());
        }
        http.perform(post("/internal/v1/collector/authors").header("X-Internal-Key", "test-key")
                .contentType(MediaType.APPLICATION_JSON).content("x".repeat(4097))).andExpect(status().isPayloadTooLarge());
        http.perform(delete("/internal/v1/collector/authors/INVALID").header("X-Internal-Key", "test-key"))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(gateway);
    }

    @Test void mapsAuthorValidationMissingAndBusyFailuresWithoutCaching() throws Exception {
        for (var pair : java.util.Map.of(ApplicationFailure.Kind.INVALID_INPUT, 400,
                ApplicationFailure.Kind.NOT_FOUND, 404, ApplicationFailure.Kind.CONFLICT, 409).entrySet()) {
            doThrow(new ApplicationFailure(pair.getKey(), "固定安全提示")).when(gateway).deleteAuthor(any());
            http.perform(delete("/internal/v1/collector/authors/123456789012345678901234").header("X-Internal-Key", "test-key"))
                    .andExpect(status().is(pair.getValue())).andExpect(header().string("Cache-Control", "no-store"))
                    .andExpect(jsonPath("$.detail").value("固定安全提示"));
        }
    }

    @Test void launchesAsyncRunAndLoginAndCheck() throws Exception {
        for (String path : List.of("runs", "login", "session/check"))
            http.perform(post("/internal/v1/collector/" + path).header("X-Internal-Key", "test-key"))
                    .andExpect(status().isAccepted()).andExpect(header().string("Cache-Control", "no-store"));
        verify(gateway).execute(Action.RUN); verify(gateway).execute(Action.LOGIN); verify(gateway).execute(Action.CHECK_SESSION);
    }
    @Test void completeAndCancelUseSeparateActions() throws Exception {
        http.perform(post("/internal/v1/collector/login/complete").header("X-Internal-Key", "test-key")).andExpect(status().isOk());
        http.perform(delete("/internal/v1/collector/login").header("X-Internal-Key", "test-key")).andExpect(status().isOk());
        verify(gateway).execute(Action.COMPLETE_LOGIN); verify(gateway).execute(Action.CANCEL_LOGIN);
    }
    @Test void imageRemainsAuthenticatedNoStoreAndNotSniffed() throws Exception {
        when(gateway.loginPreview()).thenReturn(new byte[]{1, 2, 3});
        http.perform(get("/internal/v1/collector/login/preview").header("X-Internal-Key", "test-key"))
                .andExpect(status().isOk()).andExpect(content().contentType("image/png"))
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"));
    }
    @Test void workerFailureAndConflictAlsoCannotBeCached() throws Exception {
        when(gateway.execute(Action.RUN)).thenThrow(new ApplicationFailure(ApplicationFailure.Kind.CONFLICT, "busy"));
        http.perform(post("/internal/v1/collector/runs").header("X-Internal-Key", "test-key"))
                .andExpect(status().isConflict()).andExpect(header().string("Cache-Control", "no-store"));
        when(gateway.execute(Action.STATUS)).thenThrow(new ApplicationFailure(ApplicationFailure.Kind.UNAVAILABLE, "unavailable"));
        http.perform(get("/internal/v1/collector").header("X-Internal-Key", "test-key"))
                .andExpect(status().isServiceUnavailable()).andExpect(header().string("Cache-Control", "no-store"));
    }
}
