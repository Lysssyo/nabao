# Build context: a release containing app.jar, built and verified from this source tree.
FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 --create-home nabao \
    && mkdir -p /app/public /app/status /app/push \
    && chown 1000:1000 /app/public /app/status \
    && chmod 755 /app/public /app/status \
    && chown nabao:nabao /app/push && chmod 700 /app/push
WORKDIR /app
COPY --chown=nabao:nabao app.jar app.jar
USER nabao
ENV SPRING_PROFILES_ACTIVE=mysql
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
