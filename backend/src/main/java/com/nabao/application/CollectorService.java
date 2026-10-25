package com.nabao.application;

import com.nabao.application.port.CollectorGateway;
import com.nabao.domain.CollectorModels.Action;
import com.nabao.domain.CollectorModels.Status;
import com.nabao.domain.CollectorModels.AuthorInput;
import org.springframework.stereotype.Service;

@Service
public class CollectorService {
    private final CollectorGateway gateway;
    public CollectorService(CollectorGateway gateway) { this.gateway = gateway; }
    public Status execute(Action action) { return gateway.execute(action); }
    public byte[] loginPreview() { return gateway.loginPreview(); }
    public Status addAuthor(AuthorInput input) {
        String name = input == null || input.name() == null ? "" : input.name().strip();
        String profile = input == null || input.profileUrl() == null ? "" : input.profileUrl().strip();
        if (name.isEmpty() || name.length() > 80 || name.codePoints().anyMatch(Character::isISOControl))
            throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT, "作者名称须为1至80个字符。");
        if (profile.length() > 2048 || !profile.matches("(?i:https://www\\.xiaohongshu\\.com)/user/profile/[a-f0-9]{24}(?:\\?[^\\s#<>]*)?")
                || profile.codePoints().anyMatch(value -> Character.isISOControl(value) || Character.isWhitespace(value) || Character.isSpaceChar(value)))
            throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT, "请填写有效的小红书作者主页HTTPS链接。");
        return gateway.addAuthor(new AuthorInput(name, profile));
    }
    public Status deleteAuthor(String authorId) {
        if (authorId == null || !authorId.matches("[a-f0-9]{24}"))
            throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT, "作者ID格式不正确。");
        return gateway.deleteAuthor(authorId);
    }
}
