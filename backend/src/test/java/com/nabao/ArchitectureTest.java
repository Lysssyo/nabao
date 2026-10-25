package com.nabao;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Keep the small package boundaries enforceable without adding an architecture framework. */
class ArchitectureTest {
    private static final Path SOURCE = Path.of("src/main/java/com/nabao");
    private static final List<String> IO = List.of("java.sql.", "javax.sql.", "java.nio.file.", "java.net.",
            "java.io.File", "org.springframework.jdbc.", "org.springframework.web.client.");

    @Test void applicationDependsOnPortsAndDomainRatherThanAdapters() throws IOException {
        assertNoReferences("application", List.of("com.nabao.web.", "com.nabao.infrastructure.",
                "org.springframework.web.", "org.springframework.http."));
        assertNoReferences("application", IO);
    }

    @Test void domainHasNoApplicationOrTransportDependencies() throws IOException {
        assertNoReferences("domain", List.of("com.nabao.application.", "com.nabao.web.", "com.nabao.infrastructure.",
                "org.springframework.", "com.fasterxml.jackson.databind."));
        assertNoReferences("domain", IO);
    }

    @Test void webDelegatesToUseCasesWithoutDirectPersistenceOrOutboundIO() throws IOException {
        assertNoReferences("web", List.of("com.nabao.infrastructure.", "com.nabao.application.port."));
        assertNoReferences("web", IO);
    }

    @Test void infrastructureDoesNotDependOnHttpControllers() throws IOException {
        assertNoReferences("infrastructure", List.of("com.nabao.web."));
    }

    private static void assertNoReferences(String layer, List<String> forbidden) throws IOException {
        try (var files = Files.walk(SOURCE.resolve(layer))) {
            var sources = files.filter(path -> path.toString().endsWith(".java")).toList();
            assertThat(sources).isNotEmpty();
            for (Path path : sources) {
                String code = Files.readString(path);
                for (String dependency : forbidden) {
                    assertThat(code).as("%s must not reference %s", path, dependency).doesNotContain(dependency);
                }
            }
        }
    }
}
