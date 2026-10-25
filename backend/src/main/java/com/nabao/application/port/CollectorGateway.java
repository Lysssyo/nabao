package com.nabao.application.port;

import com.nabao.domain.CollectorModels.Action;
import com.nabao.domain.CollectorModels.Status;
import com.nabao.domain.CollectorModels.AuthorInput;

public interface CollectorGateway {
    Status execute(Action action);
    byte[] loginPreview();
    Status addAuthor(AuthorInput input);
    Status deleteAuthor(String authorId);
}
