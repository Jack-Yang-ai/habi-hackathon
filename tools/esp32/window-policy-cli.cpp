#include "CaptureWindowPolicy.h"
#include <iostream>
#include <sstream>

// Test-only adapter around the exact firmware lease implementation.
int main() {
  CaptureWindowPolicy window;
  std::string line;
  while (std::getline(std::cin,line)) {
    std::istringstream input(line);
    std::string command; uint64_t now=0; input>>command;
    if(command=="update") {
      std::string id,phase,session;uint64_t request;int64_t duration;uint32_t remaining;
      if(!(input>>id>>phase>>session>>request>>duration>>remaining>>now))return 2;
      window.update(id,phase,session,request,duration,remaining);
    } else if(command=="consume") {if(!(input>>now))return 2;window.consume();}
    else if(command=="clear") {if(!(input>>now))return 2;window.clear();}
    else if(command=="state") {if(!(input>>now))return 2;}
    else return 2;
    std::cout<<"{\"id\":\""<<window.id<<"\",\"phase\":\""<<window.phase
      <<"\",\"session_id\":\""<<window.sessionId<<"\",\"remaining\":"<<window.remaining
      <<",\"expires_at_ms\":"<<window.expiresAtMs<<",\"allowed\":"<<(window.allowed(now)?"true":"false")<<"}"<<std::endl;
  }
}
