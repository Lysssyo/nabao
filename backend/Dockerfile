FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
COPY src src
RUN mvn -B -q verify

FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 --create-home nabao
WORKDIR /app
RUN mkdir -p /app/public /app/status && chown 1000:1000 /app/public /app/status && chmod 755 /app/public /app/status
RUN mkdir -p /app/push && chown nabao:nabao /app/push && chmod 700 /app/push
COPY --from=build --chown=nabao:nabao /app/target/nabao-backend-0.1.0-SNAPSHOT.jar app.jar
USER nabao
ENV SPRING_PROFILES_ACTIVE=mysql
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
