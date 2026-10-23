package com.nabao;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class NabaoApplication {
    public static void main(String[] args) {
        SpringApplication.run(NabaoApplication.class, args);
    }
}
